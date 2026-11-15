package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func shaOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// fakeDocs 模拟 ptdoc 文档服务，记录写操作（POST)与快照，供 FR-31 断言「冲突不写」。
type fakeDocs struct {
	mu        sync.Mutex
	content   string
	updatedAt int64
	posts     int
	snapshots int
	lastPost  string // 最后一次 POST body 的 content
}

func (f *fakeDocs) docFull() map[string]any {
	return map[string]any{
		"id": 1, "doc_key": "a.md", "title": "A", "filename": "a.md",
		"content": f.content, "content_sha256": shaOf(f.content), "updated_at": f.updatedAt,
	}
}

func newFakeServer(f *fakeDocs) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.URL.Path == "/api/docs" && r.Method == http.MethodGet:
			json.NewEncoder(w).Encode([]map[string]any{{"id": 1, "doc_key": "a.md", "title": "A", "filename": "a.md", "updated_at": f.updatedAt}})
		case r.URL.Path == "/api/docs/1" && r.Method == http.MethodGet:
			json.NewEncoder(w).Encode(f.docFull())
		case r.URL.Path == "/api/docs/full" && r.Method == http.MethodGet:
			json.NewEncoder(w).Encode([]map[string]any{f.docFull()})
		case r.URL.Path == "/api/docs/1/snapshots" && r.Method == http.MethodPost:
			f.snapshots++
			io.Copy(io.Discard, r.Body)
			json.NewEncoder(w).Encode(map[string]any{"id": f.snapshots})
		case r.URL.Path == "/api/docs" && r.Method == http.MethodPost:
			var body struct {
				Content string `json:"content"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			f.posts++
			f.lastPost = body.Content
			f.content = body.Content
			f.updatedAt++
			json.NewEncoder(w).Encode(map[string]any{"id": 1, "doc_key": "a.md"})
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, "not found")
		}
	}))
}

func runCtl(args ...string) int {
	return run(args, io.Discard, io.Discard)
}

func TestFR31PushConflictStopsWithoutWriting(t *testing.T) {
	f := &fakeDocs{content: "remote-v2\n", updatedAt: 1000}
	f.mu.Lock()
	f.updatedAt = 1000
	f.mu.Unlock()
	srv := newFakeServer(f)
	defer srv.Close()

	dir := t.TempDir()
	file := filepath.Join(dir, "a.md")
	os.WriteFile(file, []byte("local-v2\n"), 0o644)

	if code := runCtl("--url", srv.URL, "--token", "t", "push", file); code == 0 {
		t.Fatalf("冲突时 push 应退出非 0，实际 %d", code)
	}
	f.mu.Lock()
	if f.posts != 0 || f.snapshots != 0 {
		t.Fatalf("冲突不应写服务端：posts=%d snapshots=%d", f.posts, f.snapshots)
	}
	if f.content != "remote-v2\n" {
		t.Fatalf("服务端内容不应被改，实际 %q", f.content)
	}
	f.mu.Unlock()

	// --force：先打快照再覆盖
	if code := runCtl("--url", srv.URL, "--token", "t", "--force", "push", file); code != 0 {
		t.Fatalf("--force push 应成功，实际 %d", code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.snapshots != 1 {
		t.Fatalf("--force 覆盖前应打 1 次快照，实际 %d", f.snapshots)
	}
	if f.posts != 1 || f.lastPost != "local-v2\n" {
		t.Fatalf("--force 应覆盖为本地内容：posts=%d last=%q", f.posts, f.lastPost)
	}
}

func TestFR31PushUnchangedSkipsWrite(t *testing.T) {
	f := &fakeDocs{content: "same\n", updatedAt: 500}
	srv := newFakeServer(f)
	defer srv.Close()

	dir := t.TempDir()
	file := filepath.Join(dir, "a.md")
	os.WriteFile(file, []byte("same\n"), 0o644)

	if code := runCtl("--url", srv.URL, "--token", "t", "push", file); code != 0 {
		t.Fatalf("内容一致时 push 应成功，实际 %d", code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.posts != 0 {
		t.Fatalf("内容一致不应产生写入，posts=%d", f.posts)
	}
	if f.updatedAt != 500 {
		t.Fatalf("updated_at 不应变化，实际 %d", f.updatedAt)
	}
}

func TestFR31PullConflictStopsThenForceBacksUp(t *testing.T) {
	f := &fakeDocs{content: "remote\n", updatedAt: 1000}
	srv := newFakeServer(f)
	defer srv.Close()

	dir := t.TempDir()
	local := filepath.Join(dir, "a.md")
	os.WriteFile(local, []byte("local-edit\n"), 0o644)

	if code := runCtl("--url", srv.URL, "--token", "t", "pull", dir); code == 0 {
		t.Fatalf("pull 冲突应退出非 0，实际 %d", code)
	}
	if b, _ := os.ReadFile(local); string(b) != "local-edit\n" {
		t.Fatalf("冲突时本地不应被覆盖，实际 %q", b)
	}

	// --force：覆盖并留 .bak-<ts>
	if code := runCtl("--url", srv.URL, "--token", "t", "--force", "pull", dir); code != 0 {
		t.Fatalf("--force pull 应成功，实际 %d", code)
	}
	if b, _ := os.ReadFile(local); string(b) != "remote\n" {
		t.Fatalf("--force 后本地应等于远端，实际 %q", b)
	}
	baks, _ := filepath.Glob(local + ".bak-*")
	if len(baks) != 1 {
		t.Fatalf("应留 1 个 .bak 备份，实际 %v", baks)
	}
	if b, _ := os.ReadFile(baks[0]); string(b) != "local-edit\n" {
		t.Fatalf(".bak 应保存旧本地内容，实际 %q", strings.TrimSpace(string(b)))
	}
}
