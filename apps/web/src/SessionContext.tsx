import { createContext, useContext } from 'react'
import type { SessionApi } from './api'
export const SessionContext = createContext<SessionApi | null>(null)
export function useApi() {
  const api = useContext(SessionContext)
  if (!api) throw new Error('Missing session context')
  return api
}
