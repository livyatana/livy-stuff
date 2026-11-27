import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

async function waitForHandFont(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('400 32px "Luis Hand"'),
        document.fonts.load('400 22px "Luis Hand"'),
      ]),
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, 600);
      }),
    ]);
  } catch {
    // Proceed even if Font Loading API fails
  }
}

void waitForHandFont().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
