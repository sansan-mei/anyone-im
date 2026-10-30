import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './chat.css'
import './dialogs.css'
import './rooms.css'
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
