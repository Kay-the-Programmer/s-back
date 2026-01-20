// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyBqcS-rap5P5jRl7nhfdESKWEJtZb4Zy8c",
    authDomain: "salepilot-ae09f.firebaseapp.com",
    projectId: "salepilot-ae09f",
    storageBucket: "salepilot-ae09f.firebasestorage.app",
    messagingSenderId: "980903093215",
    appId: "1:980903093215:web:2c821c0758a9ec70335a6a",
    measurementId: "G-2885SSEE1Y"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
// Remove analytics - not supported in Node.js
export const authentication = getAuth(app);
export const storage = getStorage(app);