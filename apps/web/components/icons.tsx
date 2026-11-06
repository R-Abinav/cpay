// Inline stroke icons (self-made, no icon font or CDN). 24px grid, currentColor.
import type { ReactNode } from "react";

function Svg({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const WalletIcon = () => (
  <Svg>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18M16 14.5h2" />
  </Svg>
);
export const PayIcon = () => (
  <Svg>
    <path d="M5 19 19 5M9 5h10v10" />
  </Svg>
);
export const ReceiveIcon = () => (
  <Svg>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2M20 14v6h-6v-2M17 17v3" />
  </Svg>
);
export const ActivityIcon = () => (
  <Svg>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Svg>
);
export const MoreIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
  </Svg>
);
export const CheckIcon = ({ size = 24 }: { size?: number }) => (
  <Svg size={size}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const ChevronIcon = () => (
  <Svg size={18}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
