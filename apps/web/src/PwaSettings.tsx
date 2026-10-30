import { useEffect, useState } from 'react'
import type { MessageNotifications } from './useMessageNotifications'

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
export function usePwaInstall() {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(() => matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone)
  const [help, setHelp] = useState('')
  useEffect(() => {
    const media = matchMedia('(display-mode: standalone)')
    const before = (event: Event) => { event.preventDefault(); setPrompt(event as InstallEvent) }
    const done = () => { setInstalled(true); setPrompt(null); setHelp('') }
    const display = () => { if (media.matches) done() }
    window.addEventListener('beforeinstallprompt', before); window.addEventListener('appinstalled', done); media.addEventListener('change', display)
    return () => { window.removeEventListener('beforeinstallprompt', before); window.removeEventListener('appinstalled', done); media.removeEventListener('change', display) }
  }, [])
  const install = async () => {
    if (!prompt) { setHelp('iPhone / iPad：在 Safari 中点“分享”→“添加到主屏幕”。其他浏览器：菜单 → 安装应用 / 添加到桌面；若没有此选项，可创建网站快捷方式。'); return }
    setPrompt(null)
    try { await prompt.prompt(); await prompt.userChoice } catch { setHelp('安装未完成，可使用浏览器菜单添加到主屏幕或桌面。') }
  }
  return { installed, help, install }
}
export function PwaSettings({ install, notifications }: { install: ReturnType<typeof usePwaInstall>; notifications: MessageNotifications }) {
  return <div className="setting-section"><h3>应用与通知</h3><button className="secondary full" type="button" disabled={install.installed} onClick={() => void install.install()}>{install.installed ? '已安装到桌面' : '安装到桌面'}</button>{install.help && <p role="status" className="form-note">{install.help}</p>}<button className="secondary full" type="button" aria-pressed={notifications.enabled} onClick={() => void notifications.toggle()}>{notifications.enabled ? '关闭消息通知' : '开启消息通知'}</button>{notifications.status && <p role="status" className="form-note">{notifications.status}</p>}<p className="form-note">仅在此页面仍运行、且切到后台或失去焦点时提醒；关闭页面后不推送。通知不展示聊天正文。刷新或切换账户后需重新开启。</p></div>
}
