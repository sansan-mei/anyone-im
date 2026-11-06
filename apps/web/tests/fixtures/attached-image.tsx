import { createRoot } from 'react-dom/client'
import { AttachedImage } from '../../src/AttachedImage'
import { createSessionApi } from '../../src/api'
import { SessionContext } from '../../src/SessionContext'
import type { Attachment } from '@anyone-im/contracts'
import '../../src/chat.css'

const root = createRoot(document.getElementById('root')!)
const api = createSessionApi('fixture-owner', () => {})
let loads = 0
const attachment: Attachment = { id: 'fixture-image', roomId: 'fixture-room', filename: 'fixture.png', mimeType: 'image/png', size: 68, url: '/api/attachments/fixture-image', expiresAt: '2030-01-08T00:00:00Z', expired: false }
window.__imageFixture = {
  render(overrides = {}, mode = 'timeline') {
    const image = <AttachedImage attachment={{ ...attachment, ...overrides }} onLoad={() => loads++}/>
    root.render(<SessionContext.Provider value={api}>{mode === 'preview' ? <div className="attachment-preview">{image}<div>待发送图片</div></div> : <div id="timeline" style={{ height: 240, width: 340, overflow: 'auto' }}><div style={{ height: 1200 }}/><article className="message"><div className="bubble">{image}<div className="message-text">保留图片说明</div></div></article><div style={{ height: 1200 }}/></div>}</SessionContext.Provider>)
  },
  loads: () => loads,
}

declare global {
  interface Window {
    __imageFixture: { render: (attachment?: Partial<Attachment>, mode?: 'timeline' | 'preview') => void; loads: () => number }
    __imageIntersect: (visible: boolean) => void
  }
}
