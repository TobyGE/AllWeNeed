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

const title = "All We Need — AI, Tech & Investment Intelligence";
const description =
  "Discover, verify, and explain the AI, technology, and investment signals that matter across original public sources.";
const gaMeasurementId = "G-8R17J8CJ1W";
const analyticsBootstrap = `
(() => {
  const productionHosts = new Set([
    "allweneed.info",
    "www.allweneed.info",
    "yingqiangge.github.io",
  ]);
  if (!productionHosts.has(window.location.hostname)) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag =
    window.gtag ||
    function () {
      window.dataLayer.push(arguments);
    };

  window.gtag("consent", "default", {
    analytics_storage: navigator.globalPrivacyControl ? "denied" : "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  window.gtag("js", new Date());
  window.gtag("config", "${gaMeasurementId}", {
    anonymize_ip: true,
    send_page_view: false,
  });
  window.signalRadarAnalyticsReady = true;
})();
`;
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
    alternates: {
      canonical: "https://allweneed.info/",
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    icons: {
      icon: [{ url: "/favicon.png", type: "image/png", sizes: "64x64" }],
      apple: [
        {
          url: "/apple-touch-icon.png",
          type: "image/png",
          sizes: "180x180",
        },
      ],
    },
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: restoreFontSize }} />
        <script
          async
          src={`https://www.googletagmanager.com/gtag/js?id=${gaMeasurementId}`}
        />
        <script dangerouslySetInnerHTML={{ __html: analyticsBootstrap }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
