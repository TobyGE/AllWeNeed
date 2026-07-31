import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = "All We Need — AI 科技投资情报";
const description =
  "从 X、YouTube、Reddit、Hugging Face 和博客中发现、验证并解释真正重要的 AI 与科技投资信号。";
const restoreFontSize = `
try {
  const storedFontSize = window.localStorage.getItem("all-we-need-font-size");
  document.documentElement.dataset.fontSize =
    storedFontSize === "large" || storedFontSize === "xlarge"
      ? storedFontSize
      : "medium";
} catch {
  document.documentElement.dataset.fontSize = "medium";
}
`;

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol ?? (host?.startsWith("localhost") ? "http" : "https");
  const metadataBase = host ? new URL(`${protocol}://${host}`) : undefined;

  return {
    metadataBase,
    title,
    description,
    openGraph: {
      type: "website",
      title,
      description,
      images: [
        {
          url: "/og.png",
          width: 1731,
          height: 908,
          alt: "All We Need — AI, Tech, and Investment Intelligence",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: restoreFontSize }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
