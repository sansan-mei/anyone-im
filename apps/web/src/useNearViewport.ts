import { useEffect, useRef, useState } from 'react'

// Latch once: scrolling away must not discard authenticated bytes or restart a request.
export function useNearViewport<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [nearViewport, setNearViewport] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') { setNearViewport(true); return }
    let active = true
    const observer = new IntersectionObserver(entries => {
      if (active && entries.some(entry => entry.isIntersecting)) {
        setNearViewport(true)
        observer.disconnect()
      }
    }, { rootMargin: '200px 0px', threshold: 0 })
    observer.observe(element)
    return () => { active = false; observer.disconnect() }
  }, [])
  return { ref, nearViewport }
}
