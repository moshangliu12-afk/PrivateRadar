import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './search-refresh.css'
import './settings-refresh.css'
import './topics-refresh.css'
import './collection-page.css'
import './keyword-radar-page.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
