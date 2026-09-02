import { Navigate, Route, Routes } from 'react-router-dom';
import {
  ForgotPasswordPage,
  HomePage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './auth/pages';
import { useAuth } from './auth/AuthContext';

function ProtectedHome() {
  const { ready, user } = useAuth();
  if (!ready) return <p className="muted">Loading...</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <HomePage />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ProtectedHome />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
