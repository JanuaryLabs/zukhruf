// The native library of @zukhruf/sqlite-open. SQLite loads it into one
// connection, and it turns on persistent WAL for the main database: the -wal
// and -shm files stay after the last connection closes, so a reader that
// cannot write the folder can still open the database (ADR 0003).
//
// SQLite makes the name of the entry point from the file name, so the built
// file must be named persist_wal on every platform.
#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_persistwal_init(sqlite3 *db, char **error,
                            const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  (void)error;
  int on = 1;
  return sqlite3_file_control(db, "main", SQLITE_FCNTL_PERSIST_WAL, &on);
}
