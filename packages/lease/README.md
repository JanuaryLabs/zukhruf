# @zukhruf/lease

A lease gives one holder the right to act for a subject, for example a key of a mutex or the leadership of an election. The holder must know when it lost that right. This package gives the holder a signal that aborts when another holder may have the right. `@zukhruf/mutex`, `@zukhruf/single-flight`, and `@zukhruf/election` give out their leases with it.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## A lease is a signal

A holder gets a `Lease`. A lease has one property: `signal`, an `AbortSignal`.

- The signal aborts one time, with a `LeaseLostError`, when another holder may have the right.
- The signal never aborts when the holder releases the lease.

The holder stops its work when the signal aborts. Give the signal to each call that takes a signal, and check it before each write:

```ts
import type { Lease } from '@zukhruf/lease';

async function copyRows(lease: Lease, batches: Row[][]) {
  for (const batch of batches) {
    lease.signal.throwIfAborted();
    await fetch('https://warehouse.example/rows', {
      method: 'POST',
      body: JSON.stringify(batch),
      signal: lease.signal,
    });
  }
}
```

## Tell a lost lease from other errors

The reason of the signal is a `LeaseLostError`. Its `subject` names what the lease gave the right to. Its `cause`, when there is one, is what the issuer saw: for example, the error of a coordinator that refused the claim.

```ts
import { LeaseLostError } from '@zukhruf/lease';

try {
  await copyRows(lease, batches);
} catch (error) {
  if (error instanceof LeaseLostError) {
    console.log(`Another holder may have ${error.subject} now.`, error.cause);
  }
  throw error;
}
```

A catch with `instanceof LeaseLostError` works for the leases of each package that uses this package, because they all give the same class.

## Give out a lease

An issuer makes one `LeaseController` for each lease. It keeps the controller, and it gives the holder only the signal. `AbortController` and `AbortSignal` use the same split: only the code that has the controller can abort the signal.

```ts
import { type Lease, LeaseController } from '@zukhruf/lease';

const controller = new LeaseController('orders');
const lease: Lease = { signal: controller.signal };

// The coordinator refused the claim, so another holder may have it:
controller.lose(new Error('The coordinator refused the claim.'));

// The holder released the lease:
controller.end();
```

- `lose(cause?)` aborts the signal with `new LeaseLostError(subject, { cause })`. When you give no cause, the error has no `cause` property.
- A lease is lost one time. A second `lose` keeps the reason of the first.
- `end()` never aborts the signal. After `end()`, `lose` does nothing: the holder gave the right up, so it cannot lose it. A loss that the issuer sees late, after the release, does not reach the holder.
- `end()` can be called again. It keeps the reason of an earlier loss.

## A lease lasts for a session, not for a time

In many systems, a lease ends after a time unless the holder renews it. A lease of zukhruf has no timer. It ends when the holder releases it, or when the holder's process stops: the operating system then frees the claim of that process. It is lost when the issuer decides that another holder may have the right, for example when a coordinator refuses the claim after a failover. Thus this package has no timer and no renew.

## A lease warns the holder. It does not protect a resource

A holder can stop for some time, for example in a long garbage collection, and then write. In that time, the issuer can see the loss and give the right to another holder. The holder writes before it checks its signal. Thus the signal is a warning, not a protection.

To protect a resource, use a fencing token. The resource keeps the highest token that it accepted, and it refuses a write with a lower token. Fencing tokens will be in `@zukhruf/fencing`. A lease and a fencing token are two concepts: some systems use a lease with no token, and others use a token with no lease. See [ADR 0001](./docs/adr/0001-a-lease-is-its-own-package-apart-from-fencing.md).

## The same concepts in other systems

| This package                         | Other systems                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lease                                | Lease: Gray and Cheriton, "Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency" (1989); Kubernetes `coordination.k8s.io/v1` `Lease`; etcd `concurrency.Session` |
| `lease.signal` aborts                | etcd `Session.Done()` closes its channel; Go `ctx.Done()` closes                                                                                                                                 |
| `LeaseLostError`                     | Hazelcast `LockOwnershipLostException`; Go `context.Cause(ctx)`                                                                                                                                  |
| `LeaseController` and `Lease`        | Web `AbortController` and `AbortSignal`; Go `context.WithCancelCause`, which returns the context and its cancel function                                                                         |
| `lose(cause)` keeps the first reason | Go `cancel(cause)`: a second call does nothing; `AbortController.abort(reason)`: a second call does nothing                                                                                      |

The leases of Gray and Cheriton, Kubernetes, and etcd last for a time, and the holder renews them. The leases of zukhruf last for a session.
