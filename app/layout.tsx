import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Centr Hub",
  description: "Pipeline de ventas de Centr",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /* Tema único: oscuro. La clase `dark` va fija en el HTML servido — no
     hay toggle, ni lectura de localStorage, ni de la preferencia del
     sistema. Al ser estática desde el servidor tampoco hay flash en el
     primer paint (era lo que resolvía el script inline previo). Las
     utilidades `dark:` del resto de la app siguen vigentes: es esta
     clase la que las activa. */
  return (
    <html lang="es" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
