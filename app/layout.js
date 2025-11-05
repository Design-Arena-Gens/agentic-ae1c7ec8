export const metadata = {
  title: 'AI DJ ? Agentic Mixer',
  description: 'On-device smart crossfader with BPM estimation and DJ voiceovers',
};

import '../styles/globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {children}
      </body>
    </html>
  );
}
