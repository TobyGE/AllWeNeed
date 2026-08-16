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

const title = "All We Need — AI & Tech Intelligence";
const description =
  "Independent AI and technology intelligence: real-time updates, cross-validated analysis, and links to original public sources.";
const siteStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://allweneed.info/#website",
      url: "https://allweneed.info/",
      name: "All We Need",
      alternateName: "AllWeNeed",
      description,
      inLanguage: ["en", "zh-CN"],
      publisher: {
        "@id": "https://allweneed.info/#organization",
      },
    },
    {
      "@type": "Organization",
      "@id": "https://allweneed.info/#organization",
      name: "All We Need",
      url: "https://allweneed.info/",
      logo: {
        "@type": "ImageObject",
        url: "https://allweneed.info/apple-touch-icon.png",
        width: 180,
        height: 180,
      },
    },
  ],
};
const gaMeasurementId = "G-8R17J8CJ1W";
const analyticsBootstrap = `
(() => {
  const internalTrafficKey = "all-we-need-internal-traffic";
  const internalTrafficParam = new URLSearchParams(window.location.search).get(
    "awn_internal",
  );
  try {
    if (internalTrafficParam === "1") {
      window.localStorage.setItem(internalTrafficKey, "true");
    } else if (internalTrafficParam === "0") {
      window.localStorage.removeItem(internalTrafficKey);
    }
    if (internalTrafficParam === "1" || internalTrafficParam === "0") {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("awn_internal");
      window.history.replaceState({}, "", cleanUrl);
    }
    window.signalRadarInternalTraffic =
      window.localStorage.getItem(internalTrafficKey) === "true";
  } catch {
    window.signalRadarInternalTraffic = false;
  }

  const productionHosts = new Set([
    "allweneed.info",
    "www.allweneed.info",
    "yingqiangge.github.io",
  ]);
  if (
    !productionHosts.has(window.location.hostname) ||
    window.signalRadarInternalTraffic
  ) return;

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
    applicationName: "All We Need",
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
      icon: [{ url: "/favicon-48.png", type: "image/png", sizes: "48x48" }],
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
      siteName: "All We Need",
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(siteStructuredData).replaceAll(
              "<",
              "\\u003c",
            ),
          }}
        />
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
