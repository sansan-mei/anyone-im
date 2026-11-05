import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { MotionConfig } from 'motion/react'
import './styles.css'
import './chat.css'
import './dialogs.css'
import './rooms.css'
import './animate-ui.css'
if ('serviceWorker' in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(error => console.warn('离线应用暂不可用', error))
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><MotionConfig reducedMotion="user"><App /></MotionConfig></React.StrictMode>)
