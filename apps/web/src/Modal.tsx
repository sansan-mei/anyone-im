import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
export function Modal({ open, onOpenChange, title, description, children, sheet = false }: { open: boolean; onOpenChange: (v: boolean) => void; title: string; description: string; children: ReactNode; sheet?: boolean }) {
  const opener = useRef<HTMLElement | null>(null), wasOpen = useRef(false)
  // Capture before Radix's focus scope mounts. Each nested dialog owns its own return target.
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  wasOpen.current = open
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay"/>
      <Dialog.Content className={`modal ${sheet ? 'sheet' : ''}`} onCloseAutoFocus={event => {
        const target = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('[data-testid="message-input"], [data-testid="mobile-back"]')
        if (target) { event.preventDefault(); target.focus() }
      }}>
        <header className="modal-header"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close className="icon" aria-label="关闭弹窗"><X size={20}/></Dialog.Close></header>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
// Safari does not always focus pointer-activated buttons; make the return target deterministic.
export function rememberFocus(event: { currentTarget: HTMLElement }) { event.currentTarget.focus() }
