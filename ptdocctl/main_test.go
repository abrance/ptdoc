package main

import (
	"testing"
)

func TestIsAllDigits(t *testing.T) {
	cases := map[string]bool{"": false, "1": true, "123": true, "1a": false, "12.3": false}
	for in, want := range cases {
		if got := isAllDigits(in); got != want {
			t.Errorf("isAllDigits(%q)=%v want %v", in, got, want)
		}
	}
}

func TestFirstH1(t *testing.T) {
	if got := firstH1("intro\n\n# 标题\nbody"); got != "# 标题" {
		t.Errorf("firstH1=%q", got)
	}
	if got := firstH1("no heading"); got != "" {
		t.Errorf("firstH1=%q", got)
	}
}

func TestParseGlobalFlags(t *testing.T) {
	// 子命令在中间、flag 前后混排，= 连写
	c, pos, err := parseGlobalFlags([]string{"--url", "http://x/", "list", "--token=t1", "--user", "u", "--pass", "p"})
	if err != nil {
		t.Fatal(err)
	}
	if c.base != "http://x" || c.token != "t1" || c.user != "u" || c.pass != "p" {
		t.Fatalf("client=%+v", c)
	}
	if len(pos) != 1 || pos[0] != "list" {
		t.Fatalf("pos=%v", pos)
	}

	// 缺 --url
	if _, _, err := parseGlobalFlags([]string{"list", "--token", "t"}); err == nil {
		t.Fatal("want error for missing --url")
	}
	// 缺认证
	if _, _, err := parseGlobalFlags([]string{"--url", "http://x", "list"}); err == nil {
		t.Fatal("want error for missing auth")
	}
	// 只给 --user 不给 --pass
	if _, _, err := parseGlobalFlags([]string{"--url", "http://x", "--user", "u"}); err == nil {
		t.Fatal("want error for missing --pass")
	}
	// 未知参数
	if _, _, err := parseGlobalFlags([]string{"--url", "http://x", "--token", "t", "--nope"}); err == nil {
		t.Fatal("want error for unknown flag")
	}
	// 尾部缺值
	if _, _, err := parseGlobalFlags([]string{"--url"}); err == nil {
		t.Fatal("want error for missing value")
	}
}
