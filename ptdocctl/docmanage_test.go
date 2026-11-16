package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 覆盖 261116 新增的文档管理命令：rename / title / versions / version / snapshot / restore / export。
// 重点是「带斜杠的 doc_key 必须转义」与「命令打到的路径正确」，不重复服务端语义。
func TestDocManageCommands(t *testing.T) {
	var calls []string
	var lastBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		switch {
		case r.URL.Path == "/api/docs/7/rename" && r.Method == http.MethodPost:
			json.NewDecoder(r.Body).Decode(&lastBody)
			fmt.Fprint(w, `{"ok":true}`)
		case r.URL.Path == "/api/docs" && r.Method == http.MethodPost:
			json.NewDecoder(r.Body).Decode(&lastBody)
			fmt.Fprint(w, `{"id":7,"doc_key":"ops/a.md"}`)
		case r.URL.Path == "/api/docs/7/versions" && r.Method == http.MethodGet:
			fmt.Fprint(w, `{"items":[{"id":3,"kind":"manual","label":"发版前","size":12,"sha256_short":"abc1234","created_at":1794800000000}],"next_cursor":null}`)
		case r.URL.Path == "/api/docs/7/versions" && r.Method == http.MethodPost:
			json.NewDecoder(r.Body).Decode(&lastBody)
			fmt.Fprint(w, `{"id":9}`)
		case r.URL.Path == "/api/docs/7/versions/3" && r.Method == http.MethodGet:
			fmt.Fprint(w, `{"id":3,"content":"# 旧版\n"}`)
		case r.URL.Path == "/api/docs/7/versions/3/restore" && r.Method == http.MethodPost:
			fmt.Fprint(w, `{"ok":true,"pre_restore_version_id":10}`)
		case r.URL.Path == "/api/docs/export.zip" && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/zip")
			w.Write([]byte("PK\x03\x04fakezip"))
		// resolve() 走列表 + 单篇
		case r.URL.Path == "/api/docs" && r.Method == http.MethodGet:
			fmt.Fprint(w, `[{"id":7,"doc_key":"ops/a.md","title":"旧标题","filename":"a.md","space_id":2}]`)
		case r.URL.Path == "/api/docs/7" && r.Method == http.MethodGet:
			fmt.Fprint(w, `{"id":7,"doc_key":"ops/a.md","title":"旧标题","filename":"a.md","content":"# 旧标题\n正文\n","space_id":2}`)
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, "unexpected")
		}
	}))
	defer srv.Close()

	base := []string{"--url", srv.URL, "--token", "t"}
	runOK := func(args ...string) {
		t.Helper()
		if code := run(append(append([]string{}, base...), args...), io.Discard, io.Discard); code != 0 {
			t.Fatalf("ptdocctl %v exit=%d", args, code)
		}
	}

	runOK("rename", "ops/a.md", "renamed.md")
	if lastBody["new_key"] != "renamed.md" {
		t.Fatalf("rename body=%v", lastBody)
	}

	// title 只换 title，正文与 space_id 原样带回（否则跨空间重名会 409 或新建）
	runOK("title", "ops/a.md", "新 标题")
	if lastBody["title"] != "新 标题" || lastBody["content"] != "# 旧标题\n正文\n" {
		t.Fatalf("title body=%v", lastBody)
	}
	if lastBody["doc_key"] != "ops/a.md" || lastBody["space_id"] != float64(2) {
		t.Fatalf("title 应带 doc_key 与 space_id：%v", lastBody)
	}

	runOK("versions", "ops/a.md")
	runOK("version", "ops/a.md", "3")
	runOK("snapshot", "ops/a.md", "发布前")
	if lastBody["label"] != "发布前" {
		t.Fatalf("snapshot body=%v", lastBody)
	}
	runOK("restore", "ops/a.md", "3")

	out := filepath.Join(t.TempDir(), "out.zip")
	runOK("export", out)
	if b, err := os.ReadFile(out); err != nil || !strings.HasPrefix(string(b), "PK") {
		t.Fatalf("export 应写入 zip：%v %q", err, b)
	}

	// 关键断言：所有路径参数都做过转义，不能出现裸 ops/a.md
	for _, c := range calls {
		if strings.Contains(c, "/api/docs/ops/a.md") {
			t.Fatalf("doc_key 未转义就拼进路径：%s", c)
		}
	}
}
