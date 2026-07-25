#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define MAX_INPUT_BYTES (64 * 1024)
#define MAX_PATH_BYTES 4096

static void fail(const char *classification) {
  fprintf(stderr, "%s\n", classification);
  exit(2);
}

static void fail_errno(const char *classification) {
  fprintf(stderr, "%s:%d\n", classification, errno);
  exit(2);
}

static int safe_openat(int dirfd, const char *name, int flags, mode_t mode) {
  struct open_how how = {
      .flags = (uint64_t)(flags | O_CLOEXEC | O_NOFOLLOW),
      .mode = mode,
      .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
  };
  int fd = (int)syscall(SYS_openat2, dirfd, name, &how, sizeof(how));
  if (fd >= 0) return fd;
  if (errno != ENOSYS && errno != EINVAL && errno != E2BIG) return -1;
  return openat(dirfd, name, flags | O_CLOEXEC | O_NOFOLLOW, mode);
}

static void validate_component(const char *component) {
  if (!component[0] || strcmp(component, ".") == 0 || strcmp(component, "..") == 0 ||
      strchr(component, '/')) {
    fail("invalid-path-component");
  }
}

static void validate_directory_fd(int fd, int strict_memory_directory) {
  struct stat st;
  if (fstat(fd, &st) != 0) fail_errno("stat-directory");
  if (!S_ISDIR(st.st_mode)) fail("component-not-directory");
  if (strict_memory_directory) {
    if (st.st_uid != 0 && st.st_uid != geteuid()) fail("directory-owner-mismatch");
    if ((st.st_mode & 0022) != 0 && !(st.st_uid == 0 && (st.st_mode & S_ISVTX) != 0)) {
      fail("unsafe-directory-mode");
    }
  }
}

static int open_absolute_dir(const char *absolute, int create_last) {
  if (!absolute || absolute[0] != '/' || strlen(absolute) >= MAX_PATH_BYTES) {
    fail("invalid-root");
  }
  char path[MAX_PATH_BYTES];
  memcpy(path, absolute + 1, strlen(absolute));
  path[strlen(absolute) - 1] = '\0';

  int current = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) fail_errno("open-root");
  validate_directory_fd(current, 0);

  char *save = NULL;
  char *component = strtok_r(path, "/", &save);
  while (component) {
    validate_component(component);
    char *next = strtok_r(NULL, "/", &save);
    int child = safe_openat(current, component, O_PATH | O_DIRECTORY, 0);
    if (child < 0 && errno == ENOENT && create_last && next == NULL) {
      if (mkdirat(current, component, 0700) != 0 && errno != EEXIST) {
        close(current);
        fail_errno("mkdir-root");
      }
      child = safe_openat(current, component, O_PATH | O_DIRECTORY, 0);
    }
    if (child < 0) {
      close(current);
      fail_errno("unsafe-root-component");
    }
    validate_directory_fd(child, next == NULL);
    close(current);
    current = child;
    component = next;
  }
  return current;
}

static int open_relative_parent(int rootfd, const char *relative, char *leaf, size_t leaf_size) {
  if (!relative || relative[0] == '/' || strlen(relative) >= MAX_PATH_BYTES) {
    fail("invalid-relative-path");
  }
  char path[MAX_PATH_BYTES];
  strcpy(path, relative);
  int current = dup(rootfd);
  if (current < 0) fail_errno("dup-root");

  char *save = NULL;
  char *component = strtok_r(path, "/", &save);
  if (!component) fail("empty-relative-path");
  while (component) {
    validate_component(component);
    char *next = strtok_r(NULL, "/", &save);
    if (!next) {
      if (strlen(component) + 1 > leaf_size) fail("path-component-too-long");
      strcpy(leaf, component);
      return current;
    }
    int child = safe_openat(current, component, O_PATH | O_DIRECTORY, 0);
    if (child < 0) {
      close(current);
      fail_errno("unsafe-relative-directory");
    }
    validate_directory_fd(child, 1);
    close(current);
    current = child;
    component = next;
  }
  close(current);
  fail("empty-relative-path");
  return -1;
}

static void ensure_dir(const char *root, const char *relative) {
  int rootfd = open_absolute_dir(root, 0);
  char leaf[256];
  int parent = open_relative_parent(rootfd, relative, leaf, sizeof(leaf));
  if (mkdirat(parent, leaf, 0700) != 0 && errno != EEXIST) {
    close(parent);
    close(rootfd);
    fail_errno("mkdir-relative");
  }
  int fd = safe_openat(parent, leaf, O_PATH | O_DIRECTORY, 0);
  if (fd < 0) {
    close(parent);
    close(rootfd);
    fail_errno("unsafe-relative-directory");
  }
  close(fd);
  close(parent);
  close(rootfd);
}

static void create_file(const char *root, const char *relative) {
  int rootfd = open_absolute_dir(root, 0);
  char leaf[256];
  int parent = open_relative_parent(rootfd, relative, leaf, sizeof(leaf));
  int fd = safe_openat(parent, leaf, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0 && errno == EEXIST) {
    fd = safe_openat(parent, leaf, O_PATH, 0);
    if (fd < 0) fail_errno("unsafe-existing-file");
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) fail("existing-file-not-regular");
    close(fd);
    close(parent);
    close(rootfd);
    exit(3);
  }
  if (fd < 0) fail_errno("create-file");

  char buffer[4096];
  size_t total = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count < 0) fail_errno("read-stdin");
    if (count == 0) break;
    total += (size_t)count;
    if (total > MAX_INPUT_BYTES) fail("input-too-large");
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(fd, buffer + offset, (size_t)(count - offset));
      if (written < 0) fail_errno("write-file");
      offset += written;
    }
  }
  if (fsync(fd) != 0) fail_errno("fsync-file");
  close(fd);
  close(parent);
  close(rootfd);
}

static void read_file(const char *root, const char *relative, size_t limit, int prefix) {
  int rootfd = open_absolute_dir(root, 0);
  char leaf[256];
  int parent = open_relative_parent(rootfd, relative, leaf, sizeof(leaf));
  int fd = safe_openat(parent, leaf, O_RDONLY | O_NONBLOCK, 0);
  if (fd < 0) fail_errno("open-file");
  struct stat st;
  if (fstat(fd, &st) != 0) fail_errno("stat-file");
  if (!S_ISREG(st.st_mode)) fail("file-not-regular");
  if (!prefix && (st.st_size < 0 || (uint64_t)st.st_size > (uint64_t)limit)) {
    fprintf(stderr, "oversized:%lld:%zu\n", (long long)st.st_size, limit);
    exit(4);
  }

  char buffer[4096];
  size_t total = 0;
  for (;;) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0) fail_errno("read-file");
    if (count == 0) break;
    size_t emit = (size_t)count;
    if (total + emit > limit) emit = limit - total;
    if (emit > 0) {
      ssize_t offset = 0;
      while ((size_t)offset < emit) {
        ssize_t written = write(STDOUT_FILENO, buffer + offset, emit - (size_t)offset);
        if (written < 0) fail_errno("write-stdout");
        offset += written;
      }
    }
    total += (size_t)count;
    if (total > limit) {
      fprintf(stderr, "oversized:%lld:%zu\n", (long long)st.st_size, limit);
      exit(4);
    }
  }
  close(fd);
  close(parent);
  close(rootfd);
}

static size_t parse_limit(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno || !end || *end || parsed > MAX_INPUT_BYTES) fail("invalid-limit");
  return (size_t)parsed;
}

int main(int argc, char **argv) {
  if (argc < 3) fail("usage");
  if (strcmp(argv[1], "ensure-root") == 0 && argc == 3) {
    int fd = open_absolute_dir(argv[2], 1);
    close(fd);
    return 0;
  }
  if (strcmp(argv[1], "ensure-dir") == 0 && argc == 4) {
    ensure_dir(argv[2], argv[3]);
    return 0;
  }
  if (strcmp(argv[1], "create") == 0 && argc == 4) {
    create_file(argv[2], argv[3]);
    return 0;
  }
  if (strcmp(argv[1], "read") == 0 && argc == 5) {
    read_file(argv[2], argv[3], parse_limit(argv[4]), 0);
    return 0;
  }
  if (strcmp(argv[1], "read-prefix") == 0 && argc == 5) {
    read_file(argv[2], argv[3], parse_limit(argv[4]), 1);
    return 0;
  }
  fail("usage");
  return 2;
}
