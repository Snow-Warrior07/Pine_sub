import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyC7nYVBlMYO-s36KRevrCiIoNtPB4iEI_k",
  authDomain: "exploitos.firebaseapp.com",
  projectId: "exploitos",
  storageBucket: "exploitos.firebasestorage.app",
  messagingSenderId: "448554011149",
  appId: "1:448554011149:web:a56feeed0e5603b1bbe344",
  measurementId: "G-X1Y2029LCH",
};

// Prevent re-initialising on hot reload
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
