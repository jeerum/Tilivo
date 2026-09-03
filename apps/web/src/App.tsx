import type { ReactNode } from 'react';
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
import { AppShell } from './app/AppShell';
import { DocumentsPage } from './app/DocumentsPage';
import { SettingsPage } from './app/SettingsPage';
import { AccountingPage } from './app/AccountingPage';
import { SalesPage } from './app/SalesPage';
import { PurchasesPage } from './app/PurchasesPage';
import { BankingPage } from './app/BankingPage';
import { EmployeesPage } from './app/EmployeesPage';
import { TimeTrackingPage } from './app/TimeTrackingPage';

function Protected({ children }: { children: ReactNode }) {
  const { ready, user } = useAuth();
  if (!ready) return <p className="muted">Loading...</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <AppShell>{children}</AppShell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Protected><HomePage /></Protected>} />
      <Route path="/documents" element={<Protected><DocumentsPage /></Protected>} />
      <Route path="/accounting" element={<Protected><AccountingPage /></Protected>} />
      <Route path="/sales" element={<Protected><SalesPage /></Protected>} />
      <Route path="/purchases" element={<Protected><PurchasesPage /></Protected>} />
      <Route path="/banking" element={<Protected><BankingPage /></Protected>} />
      <Route path="/employees" element={<Protected><EmployeesPage /></Protected>} />
      <Route path="/time-tracking" element={<Protected><TimeTrackingPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
