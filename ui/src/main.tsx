import './theme.css';
// ⚠️ 必須在 render 之前：這個模組載入時就把主題套到 <html>，
// 晚了會先繪一幀錯的主題（暗版預設是「沒有 data-theme 屬性」，所以只有亮版看得到閃爍）。
import './stores/theme.js';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { connectWs } from './ws.js';

connectWs();
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
