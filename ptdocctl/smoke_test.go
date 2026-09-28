package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// smoke：起一个模拟 ptdoc API 的 httptest server，全链路跑一遍（--token 与 --user/--pass 两条路径）。
func TestSmokeAgainstFakeServer(t *testing.T) {
	wantToken := "tok123"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/auth/login" && r.Method == http.MethodPost:
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "s1"})
			fmt.Fprint(w, "{}")
		case r.URL.Path == "/api/auth/me":
			if r.Header.Get("Authorization") == "Bearer "+wantToken || r.Header.Get("Cookie") == "sid=s1" {
				fmt.Fprint(w, `{"id":1,"username":"alice","role":"admin"}`)
			} else {
				w.WriteHeader(401)
			}
		case r.URL.Path == "/api/docs" && r.Method == http.MethodGet:
			fmt.Fprint(w, `[{"id":1,"doc_key":"a.md","title":"A","filename":"a.md"}]`)
		case r.URL.Path == "/api/docs/full":
			fmt.Fprint(w, `[{"id":1,"doc_key":"a.md","title":"A","filename":"a.md","content":"# A"}]`)
		case r.URL.Path == "/api/docs/1" && r.Method == http.MethodGet:
			fmt.Fprint(w, `{"id":1,"doc_key":"a.md","title":"A","filename":"a.md","content":"# A"}`)
		case r.URL.Path == "/api/docs" && r.Method == http.MethodPost:
			fmt.Fprint(w, `{"id":2,"doc_key":"b.md"}`)
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, "not found")
		}
	}))
	defer srv.Close()

	t.Run("token flag", func(t *testing.T) {
		if err := runCmd("--url", srv.URL, "--token", wantToken, "whoami"); err != nil {
			t.Fatal(err)
		}
		if err := runCmd("--url", srv.URL, "--token", wantToken, "list"); err != nil {
			t.Fatal(err)
		}
		if err := runCmd("--token", wantToken, "--url", srv.URL, "get", "a.md"); err != nil {
			t.Fatal(err)
		}
		// flags 放子命令后面
		if err := runCmd("get", "--url", srv.URL, "--token="+wantToken, "a.md"); err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		if code := run([]string{"pull", "--url", srv.URL, "--token", wantToken, dir}, io.Discard, io.Discard); code != 0 {
			t.Fatalf("pull exit=%d", code)
		}
		if b, _ := os.ReadFile(dir + "/a.md"); string(b) != "# A" {
			t.Fatalf("pull content=%q", b)
		}
	})

	t.Run("password flags", func(t *testing.T) {
		if err := runCmd("--url", srv.URL, "--user", "alice", "--pass", "pw", "whoami"); err != nil {
			t.Fatal(err)
		}
	})
}

func runCmd(args ...string) error {
	if code := run(args, io.Discard, io.Discard); code != 0 {
		return fmt.Errorf("ptdocctl %v exit=%d", args, code)
	}
	return nil
}
