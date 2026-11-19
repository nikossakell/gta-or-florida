import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 24, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const CalendarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Icon>
);

export const HomeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const BackIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);

export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const StopwatchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="13.5" r="7.5" />
    <path d="M12 13.5 15 10.5M9.5 2.5h5M12 2.5V6" />
  </Icon>
);

export const PauseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6v12M15 6v12" />
  </Icon>
);

export const PlayIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M7 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L8.2 4.5A.8.8 0 0 0 7 5.2z" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={3}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const CrossIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={3}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Icon>
);

export const ShareIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5" />
  </Icon>
);

export const CopyIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
    <path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
  </Icon>
);

export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
  </Icon>
);

export const RetryIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.75}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.75}>
    <path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5" />
  </Icon>
);

export const OfflineIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.4M19 13a10 10 0 0 0-2.3-1.6M2 9.5a15 15 0 0 1 4.5-2.8M22 9.5A15 15 0 0 0 11 5.6" />
    <circle cx="12" cy="20" r="0.6" fill="currentColor" />
  </Icon>
);

/** Generic arcade joystick — stands for "game scenario". */
export const JoystickIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="6" r="2.75" />
    <path d="M12 8.75V15" />
    <rect x="4.5" y="15" width="15" height="5.5" rx="1.5" />
  </Icon>
);

/** Palm tree — stands for "Florida". */
export const PalmIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 9c.6 4 .2 8.5-1 12M8 21h8" />
    <path d="M12 9C10 5.5 6.5 5 4 7c3-.3 5.5.7 8 2zM12 9c2-3.5 5.5-4 8-2-3-.3-5.5.7-8 2zM12 9c-.5-2.5.5-5 3-6" />
  </Icon>
);
