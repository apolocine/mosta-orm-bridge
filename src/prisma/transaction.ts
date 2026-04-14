// Transaction helper — bridge-side shim for `dialect.$transaction`
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later
//
// If the underlying @mostajs/orm dialect exposes `$transaction(cb)`, we run the
// callback inside it (BEGIN / COMMIT / ROLLBACK on SQL dialects, replica-set
// session on MongoDB). Otherwise we execute the callback directly — with
// best-effort compensation handled by the dispatcher's own try/catch. The real
// ACID implementation is branched in S1-J3 ; this shim lets S1-J1 ship nested
// writes without waiting.

import type { IDialect } from '@mostajs/orm';

export async function runInTransaction<T>(
  dialect: IDialect,
  cb: (tx: IDialect) => Promise<T>,
): Promise<T> {
  const anyDialect = dialect as unknown as {
    $transaction?: <R>(fn: (tx: IDialect) => Promise<R>) => Promise<R>;
  };
  if (typeof anyDialect.$transaction === 'function') {
    return anyDialect.$transaction(cb);
  }
  return cb(dialect);
}
