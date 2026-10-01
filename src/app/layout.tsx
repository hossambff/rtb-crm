import type { Metadata, Viewport } from "next";
import { Playfair_Display, Work_Sans } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const workSans = Work_Sans({ variable: "--font-work-sans", subsets: ["latin"], weight: ["300", "400", "500", "600"] });
const playfair = Playfair_Display({ variable: "--font-playfair", subsets: ["latin"], weight: ["400", "500", "600"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: { default: "Roundtable Sales OS", template: "%s · Roundtable" },
  description: "RTB's AI-native sales operating system.",
  robots: { index: false, follow: false },
};

// Phones: real device width, content under the notch/home indicator handled via safe-area insets, dark browser chrome.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#070707", colorScheme: "dark" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${workSans.variable} ${playfair.variable} h-full`}>
      <body className="min-h-full bg-bg text-body">
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          mobileOffset={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom))" }}
          toastOptions={{ style: { background: "#1a1a1a", border: "1px solid #3c3c3c", color: "#f4f4f4" } }}
        />
      </body>
    </html>
  );
}
