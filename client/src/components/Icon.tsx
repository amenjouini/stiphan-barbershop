// A small custom icon set: 1.5px strokes on a 24px grid, drawn for this app.
const PATHS: Record<string, string> = {
  scissors: 'M6.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.8 8.4 20 19M8.8 15.6 20 5M13 12h.01',
  razor: 'M4 20 14.5 9.5M12 7l5 5 3.5-3.5a2.5 2.5 0 0 0 0-3.5L19 3.5a2.5 2.5 0 0 0-3.5 0zM4 20l-1 1M9.5 14.5l2 2',
  chair: 'M7 4h10v8H7zM5 12h14v3H5zM12 15v4M8 21h8M5 9v3M19 9v3',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v5M16 3v5M8 14h2M14 14h2M8 17h2',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1-4 4-5.5 7.5-5.5s6.500 1.5 7.5 5.5',
  users: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.5 3.300-5 6.500-5s5.700 1.500 6.500 5M16 4.700a3.500 3.500 0 0 1 0 6.600M18.500 15.300c1.700.700 2.700 2.200 3 4.700',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V7M16 16v-3',
  wallet: 'M3.5 7.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15zM3.500 7.500V6a2 2 0 0 1 2-2h11M16 14h1.500',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  coins: 'M9 13c3.300 0 6-1.300 6-3s-2.700-3-6-3-6 1.300-6 3 2.700 3 6 3zM3 10v4c0 1.700 2.700 3 6 3s6-1.300 6-3v-4M15 11.200c3 .200 6 1.400 6 3 0 1.700-2.700 3-6 3-1.300 0-2.500-.200-3.500-.500M21 14.200V18c0 1.700-2.700 3-6 3-2.200 0-4.100-.600-5.200-1.500',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.300l2-1.500-2-3.400-2.300.9a7 7 0 0 0-2.200-1.300L14 3h-4l-.4 2.400a7 7 0 0 0-2.200 1.300l-2.300-.9-2 3.400 2 1.500a7 7 0 0 0 0 2.600l-2 1.500 2 3.400 2.300-.9a7 7 0 0 0 2.200 1.300L10 21h4l.4-2.400a7 7 0 0 0 2.200-1.300l2.300.9 2-3.400-2-1.500c.1-.4.1-.9.1-1.300z',
  mail: 'M3.500 5.500h17v13h-17zM3.500 6.500l8.500 6.500 8.500-6.500',
  phone: 'M5 4h4l2 5-2.500 1.500a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1C10.700 20 4 13.300 4 5a1 1 0 0 1 1-1z',
  pin: 'M12 21s7-6.200 7-11.500A7 7 0 0 0 5 9.500C5 14.800 12 21 12 21zM12 12a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5z',
  check: 'M4.500 12.500l5 5 10-11',
  x: 'M5.500 5.500l13 13M18.500 5.500l-13 13',
  plus: 'M12 4.500v15M4.500 12h15',
  minus: 'M4.500 12h15',
  search: 'M10.500 17a6.500 6.500 0 1 0 0-13 6.500 6.500 0 0 0 0 13zM15.500 15.500 20 20',
  left: 'M14.500 5.500 8 12l6.500 6.500',
  right: 'M9.500 5.500 16 12l-6.500 6.500',
  arrow: 'M4 12h15M13.500 6.500 19 12l-5.500 5.500',
  menu: 'M3.500 7h17M3.500 12h17M3.500 17h17',
  logout: 'M14 4.500h5.500v15H14M10 8l-4 4 4 4M6 12h10',
  home: 'M4 10.500 12 4l8 6.500V20h-5.500v-5.500h-5V20H4z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  star: 'M12 3.500l2.600 5.400 5.900.800-4.300 4.100 1.100 5.900L12 16.900l-5.300 2.800 1.100-5.900-4.300-4.100 5.900-.800z',
  edit: 'M4 20h4L19.500 8.500a2.100 2.100 0 0 0-3-3L5 17zM14.500 7.500l3 3',
  download: 'M12 4v11M7.500 11 12 15.500 16.500 11M4.500 19.500h15',
  printer: 'M7 8.500V4h10v4.500M7 17H4.500V8.500h15V17H17M7 14h10v6H7z',
  alert: 'M12 4 2.500 20h19zM12 10v4.500M12 17.500h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.500M12 7.500h.01',
  shield: 'M12 3.500l7 2.500v5.500c0 4.500-3 7.500-7 9-4-1.500-7-4.500-7-9V6z',
  external: 'M14 4.500h5.500V10M19.500 4.500 11 13M17 13.500v6H4.500V7h6',
  history: 'M4 12a8 8 0 1 0 2.600-5.900M4 4.500V9h4.500M12 8v4.500l3 1.500',
  tag: 'M4 4h7.500l8.500 8.500-7.500 7.500L4 11.500zM8.500 8.500h.01',
  camera: 'M4 8h3l1.500-2.500h7L17 8h3v11H4zM12 16.500a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  undo: 'M8 5 4 9l4 4M4 9h10a5.500 5.500 0 0 1 0 11H9',
  block: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.700 5.700l12.600 12.600',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill={name === 'star-fill' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name === 'star-fill' ? 'star' : name] ?? PATHS.info} />
    </svg>
  );
}

/** Brand mark: a monogram B crossed by a pair of blades. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M9 6v20M9 6h7.500a5 5 0 0 1 0 10H9m0 0h8.500a5 5 0 0 1 0 10H9" stroke="var(--copper)" strokeWidth="2" />
      <path d="M22 4l5 5M27 4l-5 5" stroke="currentColor" strokeWidth="1.300" />
    </svg>
  );
}
