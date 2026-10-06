import { createContext, useContext } from 'react';
import type { Camera } from './camera';

export const CameraContext = createContext<Camera | null>(null);
export const useCamera = () => useContext(CameraContext);
