import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./_components/ThemeProvider";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fener · Sokak Aydınlatma Kontrol Paneli",
  description:
    "Şehir genelindeki sokak aydınlatmasını tek ekrandan izleyin ve kontrol edin.",
};

// İlk boyamadan önce kayıtlı temayı uygula — gündüz/gece geçişinde flash olmasın.
const themeScript = `
(function() {
  try {
    var m = localStorage.getItem('fener-theme') || 'auto';
    var dark = m === 'dark' ||
      (m === 'auto' && (function(){ var h = new Date().getHours(); return h < 7 || h >= 20; })());
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="tr"
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
