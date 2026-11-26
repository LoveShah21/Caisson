//go:build linux && agent

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunAllowedRejectsDisallowedBinaryAndGitSubcommand(t *testing.T) {
	withTestExecutables(t, map[string]string{"cat": "/bin/echo", "git": "/bin/echo"})
	if _, err := allowedExecutable("sh", []string{"-c", "id"}); err == nil {
		t.Fatal("shell was accepted")
	}
	if _, err := allowedExecutable("git", []string{"push"}); err == nil {
		t.Fatal("git push was accepted")
	}
	if _, err := allowedExecutable("/workspace/uploaded", nil); err == nil {
		t.Fatal("workspace executable was accepted")
	}
}

func TestGitArgumentsAndEnvironmentRejectSubprocessSurfaces(t *testing.T) {
	for _, args := range [][]string{
		{"push"}, {"-c", "core.hooksPath=/workspace", "status"},
		{"fetch", "ext::sh -c id"}, {"clone", "file:///workspace/repo"},
		{"clone", "https://example.com/repo", "../outside"},
		{"diff", "--ext-diff"}, {"status", "--untracked-files=all"},
	} {
		if allowedGit(args) {
			t.Fatalf("git subprocess surface accepted: %q", args)
		}
	}
	for _, args := range [][]string{
		{"fetch", "https://example.com/repo"},
		{"clone", "https://example.com/repo", "repo"},
		{"log", "--oneline"}, {"diff", "--stat"}, {"status", "--short"},
	} {
		if !allowedGit(args) {
			t.Fatalf("safe git arguments denied: %q", args)
		}
	}
	environment := strings.Join(gitChildEnv(), "\n")
	for _, setting := range []string{
		"GIT_EXEC_PATH=/usr/libexec/git-core", "GIT_ALLOW_PROTOCOL=https",
		"GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_KEY_1=credential.helper",
		"GIT_CONFIG_KEY_4=core.fsmonitor", "GIT_CONFIG_KEY_5=protocol.ext.allow",
	} {
		if !strings.Contains(environment, setting) {
			t.Fatalf("missing git isolation setting: %s", setting)
		}
	}
	if got := strings.Join(gitSafeArguments("git", []string{"diff", "--stat"}), " "); got != "diff --no-ext-diff --no-textconv --stat" {
		t.Fatalf("git diff can invoke a configured external helper: %s", got)
	}
}

func TestRunAllowedUsesFixedSanitizedEnvironment(t *testing.T) {
	withTestExecutables(t, map[string]string{"cat": "/bin/echo"})
	t.Setenv("LD_PRELOAD", "/tmp/attacker.so")
	t.Setenv("LD_LIBRARY_PATH", "/tmp")
	t.Setenv("NODE_OPTIONS", "--require /tmp/attacker.js")
	t.Setenv("PYTHONSTARTUP", "/tmp/attacker.py")
	t.Setenv("PATH", "/workspace")
	environment := strings.Join(sanitizedChildEnv(), "\n")
	if strings.Contains(environment, "LD_PRELOAD=") || strings.Contains(environment, "LD_LIBRARY_PATH=") ||
		strings.Contains(environment, "NODE_OPTIONS=") || strings.Contains(environment, "PYTHONSTARTUP=") {
		t.Fatalf("child inherited unsafe environment: %q", environment)
	}
	if !strings.Contains(environment, "PATH=/usr/local/bin:/usr/bin:/bin") {
		t.Fatalf("child did not receive fixed PATH: %q", environment)
	}
}

func TestAllowedExecutableRejectsChangedSymlink(t *testing.T) {
	directory := t.TempDir()
	link := filepath.Join(directory, "cat")
	first := filepath.Join(directory, "first")
	second := filepath.Join(directory, "second")
	for _, path := range []string{first, second} {
		if err := os.WriteFile(path, []byte("fixture"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(first, link); err != nil {
		t.Fatal(err)
	}
	originalPaths := executablePaths
	originalInodes := executableInodes
	executablePaths = map[string]string{"cat": link}
	t.Cleanup(func() {
		executablePaths = originalPaths
		executableInodes = originalInodes
	})
	if err := captureExecutableInodes(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(second, link); err != nil {
		t.Fatal(err)
	}
	if _, err := allowedExecutable("cat", nil); err == nil {
		t.Fatal("replaced allowlist symlink was accepted")
	}
}

func withTestExecutables(t *testing.T, paths map[string]string) {
	t.Helper()
	originalPaths := executablePaths
	originalInodes := executableInodes
	executablePaths = paths
	if err := captureExecutableInodes(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		executablePaths = originalPaths
		executableInodes = originalInodes
	})
}
