// API/WS 기본 주소: .env에 값이 없으면 현재 접속한 호스트를 기준으로 자동 결정합니다.
// (서버 공인 IP가 바뀌어도 .env 수정 없이 동작)
const { hostname, port, protocol, origin } = window.location
const IS_DEV_SERVER = port === '5173' || port === '4173'
const WS_PROTOCOL = protocol === 'https:' ? 'wss:' : 'ws:'

const DEFAULT_API_URL = IS_DEV_SERVER ? `${protocol}//${hostname}:8000` : origin
const DEFAULT_WS_URL = IS_DEV_SERVER
  ? `${WS_PROTOCOL}//${hostname}:8000`
  : origin.replace(/^http/, 'ws')

export const API_URL = import.meta.env.VITE_API_URL || DEFAULT_API_URL
export const WS_URL = import.meta.env.VITE_WS_URL || DEFAULT_WS_URL
