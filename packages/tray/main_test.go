package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckPrivateDir(t *testing.T) {
	root := t.TempDir()
	private := filepath.Join(root, "private")
	if err := os.Mkdir(private, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateDir(private); err != nil {
		t.Fatalf("0700 dir refused: %v", err)
	}
	open := filepath.Join(root, "open")
	if err := os.Mkdir(open, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateDir(open); err == nil {
		t.Fatal("0755 dir accepted")
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(private, link); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateDir(link); err == nil {
		t.Fatal("symlink accepted")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateDir(file); err == nil {
		t.Fatal("file accepted")
	}
}

func TestListenRefusesSharedDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "agent-sessions")
	if err := os.Mkdir(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := listen(filepath.Join(dir, "tray.sock")); err == nil {
		t.Fatal("listen accepted a world-writable directory")
	}
}

func TestStoreStateReportsChanges(t *testing.T) {
	a := &app{scheme: "vscode"}
	s := []Session{{Machine: "local", MachineName: "This machine", Agent: "claude", ID: "a", Title: "A"}}
	if a.storeState("vscode", "", nil) {
		t.Fatal("empty state over the initial one counts as a change")
	}
	if !a.storeState("vscode", "", s) {
		t.Fatal("new session not seen")
	}
	if a.storeState("vscode", "", append([]Session(nil), s...)) {
		t.Fatal("same sessions count as a change")
	}
	if !a.storeState("vscode-insiders", "", s) {
		t.Fatal("scheme change not seen")
	}
	if !a.storeState("vscode-insiders", "/usr/share/code/bin/code", s) {
		t.Fatal("cli change not seen")
	}
	changed := append([]Session(nil), s...)
	changed[0].Title = "B"
	if !a.storeState("vscode-insiders", "/usr/share/code/bin/code", changed) {
		t.Fatal("title change not seen")
	}
}
