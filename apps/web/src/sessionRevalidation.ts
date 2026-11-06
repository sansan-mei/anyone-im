export type VerificationState = 'checking' | 'uncertain' | 'verified'
type Options = {
  ownerId: string
  check: () => Promise<{ user: { id: string } | null }>
  isCurrent: () => boolean
  hold: () => void
  resume: () => void
  invalidate: () => void
  onState: (state: VerificationState) => void
}

// A reversible identity hold is not a logout: keep the workspace/cache mounted,
// but allow no protected work until the cookie-authoritative identity is known.
export function createSessionRevalidator(options: Options) {
  let disposed = false
  let flight: Promise<void> | undefined
  const current = () => !disposed && options.isCurrent()
  return {
    revalidate: (): Promise<void> => {
      if (!current()) return Promise.resolve()
      if (flight) return flight
      options.hold()
      options.onState('checking')
      const pending = Promise.resolve().then(options.check).then(session => {
        // Release before publishing: a focus/retry triggered during completion
        // must start a new check, not join an already-settled promise.
        if (flight === pending) flight = undefined
        if (!current()) return
        if (session.user?.id !== options.ownerId) { options.invalidate(); return }
        options.resume()
        options.onState('verified')
      }, error => {
        if (flight === pending) flight = undefined
        if (!current()) return
        const failure = error as { status?: number; code?: string } | null
        if (failure?.status === 401 || failure?.code === 'SESSION_CHANGED') options.invalidate()
        else options.onState('uncertain')
      })
      flight = pending
      return pending
    },
    dispose: () => { disposed = true },
  }
}
