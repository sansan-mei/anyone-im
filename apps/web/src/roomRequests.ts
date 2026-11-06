// Session-local pending work only. Publication, notification baselines and
// generation checks belong to each caller, not to the shared request.
export function createRoomRequest<T>(load: () => Promise<T>): () => Promise<T> {
  let flight: Promise<T> | undefined
  return () => {
    if (flight) return flight
    const pending = load().then(value => {
      if (flight === pending) flight = undefined
      return value
    }, error => {
      if (flight === pending) flight = undefined
      throw error
    })
    flight = pending
    return pending
  }
}
