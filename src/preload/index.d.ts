import { ElectronAPI } from '@electron-toolkit/preload'
import type { ThreecxApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: ThreecxApi
  }
}
