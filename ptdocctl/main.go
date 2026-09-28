// ptdocctl — ptdoc server 命令行客户端（零依赖，Go 标准库实现）。
//
// 全局参数（可放在子命令前或后，值也可用 = 连写，如 --token=xxx）：
//
//	--url <地址>    服务地址，如 https://ptdoc.xiaoyxq.top（必需）
//	--token <t>     设置页生成的静态 API Token（与登录 Cookie 等价；推荐）
//	--user <name>   无 Token 时用用户名+密码登录（配合 --pass）
//	--pass <pw>     同上，密码
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
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type doc struct {
	ID          int64  `json:"id"`
	DocKey      string `json:"doc_key"`
	Title       string `json:"title"`
	Filename    string `json:"filename"`
	Content     string `json:"content,omitempty"`
	UpdatedAtMs int64  `json:"updated_at"`
}

type client struct {
	base   string
	hc     *http.Client
	token  string
	user   string
	pass   string
	cookie string
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
	b, err := c.do(http.MethodGet, "/api/docs", nil)
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
	b, err := c.do(http.MethodGet, "/api/docs", nil)
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
	b, err := c.do(http.MethodGet, "/api/docs?q="+urlQueryEscape(q), nil)
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

// pushOne 上传单个文件。docKey 为空时取文件名；title 取 md 首个 # 标题，空则用文件名。
func (c *client) pushOne(path, docKey string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if docKey == "" {
		docKey = filepath.Base(path)
	}
	if !strings.HasSuffix(strings.ToLower(docKey), ".md") {
		docKey += ".md"
	}
	title := strings.TrimPrefix(strings.TrimSpace(firstH1(string(data))), "# ")
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(docKey), ".md")
	}
	payload, _ := json.Marshal(map[string]string{
		"doc_key":  docKey,
		"title":    title,
		"filename": filepath.Base(docKey),
		"content":  string(data),
	})
	if _, err := c.do(http.MethodPost, "/api/docs", payload); err != nil {
		return err
	}
	fmt.Printf("已上传 %s → %s\n", path, docKey)
	return nil
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

func (c *client) push(files []string) error {
	for _, f := range files {
		if err := c.pushOne(f, ""); err != nil {
			return fmt.Errorf("push %s: %w", f, err)
		}
	}
	return nil
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
	for _, f := range files {
		rel, err := filepath.Rel(dir, f)
		if err != nil {
			return err
		}
		if err := c.pushOne(f, rel); err != nil {
			return fmt.Errorf("push %s: %w", f, err)
		}
	}
	fmt.Printf("共上传 %d 个文件\n", len(files))
	return nil
}

func (c *client) pull(dir string) error {
	if dir == "" {
		dir = "docs"
	}
	b, err := c.do(http.MethodGet, "/api/docs/full", nil)
	if err != nil {
		return err
	}
	var docs []doc
	if err := decode(b, &docs); err != nil {
		return err
	}
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
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, []byte(d.Content), 0o644); err != nil {
			return err
		}
		fmt.Printf("已写入 %s\n", p)
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
