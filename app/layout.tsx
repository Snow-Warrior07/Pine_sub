import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "../lib/AuthContext";
import WavyLayer from "./WavyLayer";

export const metadata: Metadata = {
  title: "ZeroDayOS — AI AppSec Team",
  description: "ZeroDayOS AI AppSec Team dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <WavyLayer />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
