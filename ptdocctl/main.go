// ptdocctl — ptdoc server 命令行客户端（零依赖，Go 标准库实现）。
//
// 全局参数（可放在子命令前或后，值也可用 = 连写，如 --token=xxx）：
//
//	--url <地址>    服务地址，如 https://ptdoc.xiaoyxq.top（必需）
//	--token <t>     设置页生成的静态 API Token（与登录 Cookie 等价；推荐）
//	--user <name>   无 Token 时用用户名+密码登录（配合 --pass）
//	--pass <pw>     同上，密码
//	--space <s>     空间名或 id；读命令按它过滤，写命令落该空间，缺省落默认空间
//	--force         push/pull 覆盖前比内容，冲突时强行覆盖（push 先打快照；pull 先另存 .bak-<ts>）
//
// 子命令：
//
//	ptdocctl whoami                     # 验证连接与身份
//	ptdocctl list                       # 列出工作区全部文档
//	ptdocctl get <doc_id|doc_key>       # 打印文档全文
//	ptdocctl pull [dir]                 # 全量拉取工作区 md 到本地目录（默认 ./docs）
//	ptdocctl push <file> [file...]      # 上传 md（doc_key=文件名）
//	ptdocctl pushr <dir>                # 递归 push 目录，doc_key 含子目录路径
//	ptdocctl delete <doc_id>
//	ptdocctl search <keyword>
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type doc struct {
	ID          int64  `json:"id"`
	DocKey      string `json:"doc_key"`
	Title       string `json:"title"`
	Filename    string `json:"filename"`
	Content     string `json:"content,omitempty"`
	ContentSha  string `json:"content_sha256,omitempty"`
	UpdatedAtMs int64  `json:"updated_at"`
}

type client struct {
	base   string
	hc     *http.Client
	token  string
	user   string
	pass   string
	cookie string
	// space 是 --space 的原样值（名字或 id）；spaceID 解析后缓存，0 表示还没解析
	space   string
	spaceID int64
	// force：push/pull 冲突时强制覆盖（覆盖前 push 打快照、pull 留 .bak）
	force bool
}

// parseGlobalFlags 从任意位置（子命令前后均可）析出 --url/--token/--user/--pass，
// 返回客户端与剩余位置参数。支持 --flag value 与 --flag=value 两种写法。
func parseGlobalFlags(argv []string) (*client, []string, error) {
	c := &client{hc: &http.Client{}}
	var pos []string
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if !strings.HasPrefix(a, "--") {
			pos = append(pos, a)
			continue
		}
		name := strings.TrimPrefix(a, "--")
		// --force 是布尔开关，不取值
		if name == "force" || name == "force=true" {
			c.force = true
			continue
		}
		var val string
		if eq := strings.Index(name, "="); eq >= 0 {
			val, name = name[eq+1:], name[:eq]
		} else if i+1 < len(argv) {
			i++
			val = argv[i]
		} else {
			return nil, nil, fmt.Errorf("参数 %s 缺少值", a)
		}
		switch name {
		case "url":
			c.base = strings.TrimRight(val, "/")
		case "token":
			c.token = val
		case "user":
			c.user = val
		case "pass":
			c.pass = val
		case "space":
			c.space = val
		default:
			return nil, nil, fmt.Errorf("未知参数: --%s", name)
		}
	}
	if c.base == "" {
		return nil, nil, fmt.Errorf("缺少 --url，例如 --url http://localhost:5173")
	}
	if c.token == "" && (c.user == "" || c.pass == "") {
		return nil, nil, fmt.Errorf("缺少 --token（或 --user 与 --pass）")
	}
	return c, pos, nil
}

type spaceRow struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	IsDefault int    `json:"is_default"`
}

// resolveSpace 把 --space 的名字/id 解析成空间 id；没给 --space 时返回 0（服务端按默认空间处理）。
// 名字不存在时报错并列出可用空间，避免「拼错了却静默落到默认空间」。
func (c *client) resolveSpace() (int64, error) {
	if c.space == "" {
		return 0, nil
	}
	if c.spaceID > 0 {
		return c.spaceID, nil
	}
	b, err := c.do(http.MethodGet, "/api/spaces", nil)
	if err != nil {
		return 0, fmt.Errorf("读取空间列表失败: %w", err)
	}
	var data struct {
		Spaces []spaceRow `json:"spaces"`
	}
	if err := decode(b, &data); err != nil {
		return 0, err
	}
	if isAllDigits(c.space) {
		id := int64(0)
		fmt.Sscan(c.space, &id)
		for _, s := range data.Spaces {
			if s.ID == id {
				c.spaceID = id
				return id, nil
			}
		}
	}
	for _, s := range data.Spaces {
		if strings.EqualFold(s.Name, c.space) {
			c.spaceID = s.ID
			return s.ID, nil
		}
	}
	names := make([]string, 0, len(data.Spaces))
	for _, s := range data.Spaces {
		names = append(names, s.Name)
	}
	return 0, fmt.Errorf("空间「%s」不存在；可用空间：%s", c.space, strings.Join(names, ", "))
}

// spaceQuery 返回读命令要带的 ?space= 片段（未指定 --space 时为空，即服务端不过滤）。
func (c *client) spaceQuery() (string, error) {
	id, err := c.resolveSpace()
	if err != nil {
		return "", err
	}
	if id == 0 {
		return "", nil
	}
	return "?space=" + fmt.Sprint(id), nil
}

func trunc(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}

// login 用用户名+密码换取会话 Cookie（仅当未提供 --token 时使用）。
func (c *client) login() error {
	if c.user == "" || c.pass == "" {
		return fmt.Errorf("需要 --token，或同时提供 --user 与 --pass")
	}
	body, _ := json.Marshal(map[string]string{"username": c.user, "password": c.pass})
	resp, err := c.hc.Post(c.base+"/api/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("登录失败(HTTP %d): %s", resp.StatusCode, trunc(b))
	}
	for _, ck := range resp.Cookies() {
		c.cookie = ck.Name + "=" + ck.Value
		break
	}
	if c.cookie == "" {
		return fmt.Errorf("登录成功但响应未携带会话 Cookie")
	}
	return nil
}

func (c *client) do(method, path string, body []byte) ([]byte, error) {
	if c.token == "" && c.cookie == "" {
		if err := c.login(); err != nil {
			return nil, err
		}
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", c.cookie)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, trunc(b))
	}
	return b, nil
}

func usage(w io.Writer) {
	fmt.Fprint(w, `ptdocctl — ptdoc server 命令行客户端

全局参数（子命令前后均可）:
  --url <地址>    服务地址，如 https://ptdoc.xiaoyxq.top（必需）
  --token <t>     设置页生成的静态 API Token（推荐）
  --user <name>   无 Token 时用用户名+密码登录（配合 --pass）
  --pass <pw>     同上，密码
  --force         push/pull 覆盖前比内容，冲突时强行覆盖（push 先打快照；pull 先另存 .bak-<ts>）

用法:
  ptdocctl --url <地址> --token <t> <子命令> [参数...]

子命令:
  whoami                     验证连接与身份
  list                       列出工作区全部文档
  get <doc_id|doc_key>       打印文档全文
  pull [dir]                 全量拉取工作区 md 到本地目录（默认 ./docs）
  push <file> [file...]      上传 md（doc_key=文件名）
  pushr <dir>                递归 push 目录，doc_key 含子目录路径
  delete <doc_id>            删除文档
  search <keyword>           搜索文档
`)
}

func decode(b []byte, v any) error {
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("响应解析失败: %w（原文: %s）", err, trunc(b))
	}
	return nil
}

func (c *client) whoami() error {
	b, err := c.do(http.MethodGet, "/api/auth/me", nil)
	if err != nil {
		return err
	}
	var u struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if err := decode(b, &u); err != nil {
		return err
	}
	fmt.Printf("user=%s id=%d role=%s server=%s\n", u.Username, u.ID, u.Role, c.base)
	return nil
}

func (c *client) list() error {
	q, err := c.spaceQuery()
	if err != nil {
		return err
	}
	b, err := c.do(http.MethodGet, "/api/docs"+q, nil)
	if err != nil {
		return err
	}
	var docs []doc
	if err := decode(b, &docs); err != nil {
		return err
	}
	for _, d := range docs {
		title := d.Title
		if title == "" {
			title = d.Filename
		}
		fmt.Printf("%d\t%s\t%s\n", d.ID, d.DocKey, title)
	}
	return nil
}

// resolve 把 id 或 doc_key 归一到 {doc_id, doc_key}。doc_key 需先查列表拿到 id（POST 更新要用）。
func (c *client) resolve(s string) (*doc, error) {
	if isAllDigits(s) {
		b, err := c.do(http.MethodGet, "/api/docs/"+s, nil)
		if err == nil {
			var d doc
			if err := decode(b, &d); err == nil {
				return &d, nil
			}
		}
		// 404 等失败不致命：id 形参也可能是纯数字文件名，继续按 doc_key 查。
	}
	q, err := c.spaceQuery()
	if err != nil {
		return nil, err
	}
	b, err := c.do(http.MethodGet, "/api/docs"+q, nil)
	if err != nil {
		return nil, err
	}
	var docs []doc
	if err := decode(b, &docs); err != nil {
		return nil, err
	}
	for i := range docs {
		if docs[i].DocKey == s || docs[i].Filename == s {
			// 列表接口不带 content，取全文需再按 id 查一次。
			full, err := c.do(http.MethodGet, fmt.Sprintf("/api/docs/%d", docs[i].ID), nil)
			if err != nil {
				return nil, err
			}
			var d doc
			if err := decode(full, &d); err != nil {
				return nil, err
			}
			return &d, nil
		}
	}
	return nil, fmt.Errorf("未找到文档: %s", s)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func (c *client) get(s string) error {
	d, err := c.resolve(s)
	if err != nil {
		return err
	}
	fmt.Print(d.Content)
	if len(d.Content) > 0 && !strings.HasSuffix(d.Content, "\n") {
		fmt.Println()
	}
	return nil
}

func (c *client) del(s string) error {
	d, err := c.resolve(s)
	if err != nil {
		return err
	}
	if _, err := c.do(http.MethodDelete, fmt.Sprintf("/api/docs/%d", d.ID), nil); err != nil {
		return err
	}
	fmt.Printf("已删除 %d\t%s\n", d.ID, d.DocKey)
	return nil
}

func (c *client) search(q string) error {
	params := url.Values{}
	params.Set("q", q)
	id, err := c.resolveSpace()
	if err != nil {
		return err
	}
	if id > 0 {
		params.Set("space", fmt.Sprint(id))
	}
	b, err := c.do(http.MethodGet, "/api/docs?"+params.Encode(), nil)
	if err != nil {
		return err
	}
	var docs []doc
	if err := decode(b, &docs); err != nil {
		return err
	}
	for _, d := range docs {
		fmt.Printf("%d\t%s\t%s\n", d.ID, d.DocKey, d.Title)
	}
	return nil
}

func urlQueryEscape(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

// conflict 记录一次「本地与远端都改过」的冲突，供结束时统一列清单。
type conflict struct {
	docKey      string
	localMtime  string
	remoteMtime string
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return fmt.Sprintf("%x", sum)
}

func fileMtime(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return "-"
	}
	return info.ModTime().Format(time.RFC3339)
}

func remoteMtime(d *doc) string {
	if d == nil || d.UpdatedAtMs <= 0 {
		return "-"
	}
	return time.UnixMilli(d.UpdatedAtMs).Format(time.RFC3339)
}

// findRemote 按 doc_key 在目标空间精确查现有文档（含 content_sha256）；不存在返回 (nil,nil)。
func (c *client) findRemote(docKey string) (*doc, error) {
	q, err := c.spaceQuery()
	if err != nil {
		return nil, err
	}
	b, err := c.do(http.MethodGet, "/api/docs"+q, nil)
	if err != nil {
		return nil, err
	}
	var docs []doc
	if err := decode(b, &docs); err != nil {
		return nil, err
	}
	for _, d := range docs {
		if d.DocKey != docKey {
			continue
		}
		full, err := c.do(http.MethodGet, fmt.Sprintf("/api/docs/%d", d.ID), nil)
		if err != nil {
			return nil, err
		}
		var fd doc
		if err := decode(full, &fd); err != nil {
			return nil, err
		}
		return &fd, nil
	}
	return nil, nil
}

// snapshot 覆盖前给远端文档打一条手动快照（复用服务端已有 createSnapshot）。
func (c *client) snapshot(id int64, label string) error {
	body, _ := json.Marshal(map[string]any{"label": label})
	_, err := c.do(http.MethodPost, fmt.Sprintf("/api/docs/%d/snapshots", id), body)
	return err
}

func remoteSha(d *doc) string {
	if d == nil {
		return ""
	}
	if d.ContentSha != "" {
		return d.ContentSha
	}
	if d.Content != "" {
		return sha256Hex([]byte(d.Content))
	}
	return ""
}

// pushOne 上传单个文件。docKey 为空时取文件名；title 取 md 首个 # 标题，空则用文件名。
// 覆盖前比内容：远端不存在 → 新建；内容一致 → 跳过（不写，updated_at 不变）；
// 不一致 → 非 --force 时记冲突不写，--force 时先打快照再覆盖。返回是否真的写了服务端。
func (c *client) pushOne(path, docKey string, conflicts *[]conflict) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	if docKey == "" {
		docKey = filepath.Base(path)
	}
	if !strings.HasSuffix(strings.ToLower(docKey), ".md") {
		docKey += ".md"
	}
	localSha := sha256Hex(data)

	existing, err := c.findRemote(docKey)
	if err != nil {
		return false, err
	}
	if existing != nil {
		if remoteSha(existing) == localSha {
			fmt.Printf("未改动 %s → %s（内容一致，跳过）\n", path, docKey)
			return false, nil
		}
		if !c.force {
			*conflicts = append(*conflicts, conflict{docKey: docKey, localMtime: fileMtime(path), remoteMtime: remoteMtime(existing)})
			return false, nil
		}
		if err := c.snapshot(existing.ID, "ptdocctl push --force 覆盖前快照"); err != nil {
			return false, fmt.Errorf("创建快照失败: %w", err)
		}
	}

	title := strings.TrimPrefix(strings.TrimSpace(firstH1(string(data))), "# ")
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(docKey), ".md")
	}
	body := map[string]any{
		"doc_key":  docKey,
		"title":    title,
		"filename": filepath.Base(docKey),
		"content":  string(data),
	}
	spaceID, err := c.resolveSpace()
	if err != nil {
		return false, err
	}
	if spaceID > 0 {
		body["space_id"] = spaceID
	}
	payload, _ := json.Marshal(body)
	res, err := c.do(http.MethodPost, "/api/docs", payload)
	if err != nil {
		return false, err
	}
	// 服务端在目标空间撞名时会自动加 ~2，回显最终 key 才不会让人以为推的是原名
	final := docKey
	var created struct {
		DocKey string `json:"doc_key"`
	}
	if err := decode(res, &created); err == nil && created.DocKey != "" {
		final = created.DocKey
	}
	if final != docKey {
		fmt.Printf("已上传 %s → %s（目标空间已有同名，服务端改写为 %s）\n", path, docKey, final)
		return true, nil
	}
	fmt.Printf("已上传 %s → %s\n", path, final)
	return true, nil
}

// firstH1 返回第一处行首 "# " 行（保持简单：不处理 front-matter）。
func firstH1(s string) string {
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "# ") {
			return t
		}
	}
	return ""
}

// reportConflicts 打印冲突清单；有冲突则返回非 nil 错误让进程退出码非 0。
func reportConflicts(cs []conflict) error {
	if len(cs) == 0 {
		return nil
	}
	fmt.Fprintf(os.Stderr, "检测到 %d 个内容冲突（本地与远端都改过），未覆盖：\n", len(cs))
	for _, cf := range cs {
		fmt.Fprintf(os.Stderr, "  %s\t本地 %s\t远端 %s\n", cf.docKey, cf.localMtime, cf.remoteMtime)
	}
	fmt.Fprintln(os.Stderr, "确认要覆盖请加 --force")
	return fmt.Errorf("检测到 %d 个内容冲突，已中止", len(cs))
}

func (c *client) push(files []string) error {
	var conflicts []conflict
	for _, f := range files {
		if _, err := c.pushOne(f, "", &conflicts); err != nil {
			return fmt.Errorf("push %s: %w", f, err)
		}
	}
	return reportConflicts(conflicts)
}

func (c *client) pushr(dir string) error {
	var files []string
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(strings.ToLower(p), ".md") {
			return nil
		}
		files = append(files, p)
		return nil
	})
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("%s 下没有 .md 文件", dir)
	}
	var conflicts []conflict
	written := 0
	for _, f := range files {
		rel, err := filepath.Rel(dir, f)
		if err != nil {
			return err
		}
		wrote, err := c.pushOne(f, rel, &conflicts)
		if err != nil {
			return fmt.Errorf("push %s: %w", f, err)
		}
		if wrote {
			written++
		}
	}
	if err := reportConflicts(conflicts); err != nil {
		return err
	}
	fmt.Printf("共处理 %d 个文件，实际上传 %d 个\n", len(files), written)
	return nil
}

func (c *client) pull(dir string) error {
	if dir == "" {
		dir = "docs"
	}
	q, err := c.spaceQuery()
	if err != nil {
		return err
	}
	b, err := c.do(http.MethodGet, "/api/docs/full"+q, nil)
	if err != nil {
		return err
	}
	var docs []doc
	if err := decode(b, &docs); err != nil {
		return err
	}
	var conflicts []conflict
	for _, d := range docs {
		key := filepath.FromSlash(d.DocKey)
		if strings.HasPrefix(key, "/") || strings.Contains(key, "..") {
			fmt.Fprintf(os.Stderr, "跳过异常 doc_key: %s\n", d.DocKey)
			continue
		}
		p := filepath.Join(dir, key)
		if !strings.HasSuffix(strings.ToLower(p), ".md") {
			p += ".md"
		}
		remote := remoteSha(&d)
		if local, err := os.ReadFile(p); err == nil {
			if sha256Hex(local) == remote {
				fmt.Printf("未改动 %s（内容一致，跳过）\n", p)
				continue
			}
			if !c.force {
				conflicts = append(conflicts, conflict{docKey: d.DocKey, localMtime: fileMtime(p), remoteMtime: remoteMtime(&d)})
				continue
			}
			// --force：覆盖前把本地另存 .bak-<ts>
			bak := fmt.Sprintf("%s.bak-%d", p, time.Now().Unix())
			if err := os.WriteFile(bak, local, 0o644); err != nil {
				return err
			}
			fmt.Printf("已备份 %s\n", bak)
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, []byte(d.Content), 0o644); err != nil {
			return err
		}
		fmt.Printf("已写入 %s\n", p)
	}
	if err := reportConflicts(conflicts); err != nil {
		return err
	}
	fmt.Printf("共拉取 %d 个文档 → %s\n", len(docs), dir)
	return nil
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(argv []string, stdout, stderr io.Writer) int {
	if len(argv) < 1 {
		usage(stderr)
		return 2
	}
	cmd := argv[0]
	args := argv[1:]

	if cmd == "help" || cmd == "-h" || cmd == "--help" {
		usage(stdout)
		return 0
	}

	c, argv, err := parseGlobalFlags(argv)
	if err != nil {
		fmt.Fprintln(stderr, "ptdocctl:", err)
		return 1
	}
	if len(argv) < 1 {
		fmt.Fprintln(stderr, "缺少子命令")
		usage(stderr)
		return 2
	}
	cmd = argv[0]
	args = argv[1:]

	switch cmd {
	case "whoami":
		err = c.whoami()
	case "list":
		err = c.list()
	case "get":
		if len(args) != 1 {
			err = fmt.Errorf("用法: ptdocctl get <doc_id|doc_key>")
			break
		}
		err = c.get(args[0])
	case "delete":
		if len(args) != 1 {
			err = fmt.Errorf("用法: ptdocctl delete <doc_id>")
			break
		}
		err = c.del(args[0])
	case "search":
		if len(args) != 1 {
			err = fmt.Errorf("用法: ptdocctl search <keyword>")
			break
		}
		err = c.search(args[0])
	case "pull":
		err = c.pull(strings.Join(args, " "))
	case "push":
		if len(args) < 1 {
			err = fmt.Errorf("用法: ptdocctl push <file> [file...]")
			break
		}
		err = c.push(args)
	case "pushr":
		if len(args) != 1 {
			err = fmt.Errorf("用法: ptdocctl pushr <dir>")
			break
		}
		err = c.pushr(args[0])
	default:
		fmt.Fprintf(stderr, "未知命令: %s\n\n", cmd)
		usage(stderr)
		return 2
	}
	if err != nil {
		fmt.Fprintln(stderr, "ptdocctl:", err)
		return 1
	}
	return 0
}
