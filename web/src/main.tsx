import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Trang kiểm tra vị trí (/review) tách chunk riêng: người dùng bản đồ không phải tải
const ReviewPage = lazy(() => import('./components/ReviewPage').then((m) => ({ default: m.ReviewPage })));
const isReview = location.pathname.replace(/\/+$/, '') === '/review';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isReview ? (
      <Suspense fallback={null}>
        <ReviewPage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);

// PWA: cache tile/font/sprite -> mở lại gần như tức thì, vẫn xem được khi sóng yếu
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(console.error));
}
