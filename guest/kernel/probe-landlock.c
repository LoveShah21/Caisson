// Test-only PID 1 for the pinned guest-kernel Landlock preflight.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int probe_exec(const char *path) {
  pid_t child = fork();
  if (child < 0) return -1;
  if (child == 0) {
    char *const arguments[] = {(char *)path, (char *)"--child", NULL};
    execv(path, arguments);
    _exit(errno == EACCES ? 42 : 43);
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return -1;
  return WEXITSTATUS(status);
}

static void wait_for_host(void) {
  fflush(stdout);
  for (;;) pause();
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--child") == 0) return 0;

  int baseline = probe_exec("/denied");
  printf("LANDLOCK_BASELINE_EXIT=%d\n", baseline);
  if (baseline != 0) {
    printf("LANDLOCK_PROBE=FAIL baseline executable did not run\n");
    wait_for_host();
  }

  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  printf("LANDLOCK_ABI=%d\n", abi);
  if (abi < 1) {
    printf("LANDLOCK_PROBE=UNAVAILABLE errno=%d\n", errno);
    wait_for_host();
  }

  struct landlock_ruleset_attr ruleset = {
      .handled_access_fs = LANDLOCK_ACCESS_FS_EXECUTE,
  };
  int ruleset_fd = syscall(SYS_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) {
    printf("LANDLOCK_RULESET=FAILED errno=%d\n", errno);
    wait_for_host();
  }

  int allowed_fd = open("/init", O_PATH | O_CLOEXEC);
  struct landlock_path_beneath_attr rule = {
      .allowed_access = LANDLOCK_ACCESS_FS_EXECUTE,
      .parent_fd = allowed_fd,
  };
  if (allowed_fd < 0 ||
      syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
      syscall(SYS_landlock_restrict_self, ruleset_fd, 0) < 0) {
    printf("LANDLOCK_RESTRICT=FAILED errno=%d\n", errno);
    wait_for_host();
  }
  close(allowed_fd);
  close(ruleset_fd);

  int allowed = probe_exec("/init");
  int denied = probe_exec("/denied");
  printf("LANDLOCK_ALLOWED_EXIT=%d\nLANDLOCK_DENIED_EXIT=%d\n", allowed, denied);
  printf("LANDLOCK_PROBE=%s\n", allowed == 0 && denied == 42 ? "PASS" : "FAIL");
  wait_for_host();
}
