import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/manrope';
import '@fontsource/tajawal/400.css';
import '@fontsource/tajawal/500.css';
import '@fontsource/tajawal/700.css';
import '@fontsource/amiri/arabic-400.css';
import './styles/base.css';
import './styles/site.css';
import './styles/app.css';

import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppIndex, AppLayout, OwnerOnly } from './app/AppLayout';
import { MyEarnings, MySchedule, Today } from './app/Chair';
import { Expenses, Payments, Payroll, Reports } from './app/Money';
import { Activity, Outbox, Reviews, ServicesAdmin, Settings } from './app/Setup';
import { Appointments, CustomerDetail, Customers, Overview, ShopCalendar } from './app/Shop';
import { Team, TeamDetail } from './app/Team';
import { AuthProvider, ShopProvider, ToastProvider } from './lib/context';
import { I18nProvider } from './lib/i18n';
import { Account, Manage } from './site/Account';
import { Forgot, Login, Register, SetPassword } from './site/Auth';
import { Book } from './site/Book';
import { BarbersPage, Home, NotFound, ServicesPage, SiteLayout } from './site/Pages';

/** Last line of defence: a render error shows a recoverable message instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boot on-ink">
        <div className="empty">
          <h3>Something broke on this screen.</h3>
          <p>Your data is safe. Reload the page to carry on; if it keeps happening, tell the shop owner what you were doing.</p>
          <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

const owner = (el: JSX.Element) => <OwnerOnly>{el}</OwnerOnly>;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <I18nProvider>
        <ToastProvider>
          <ShopProvider>
            <AuthProvider>
              <Routes>
                <Route element={<SiteLayout />}>
                  <Route index element={<Home />} />
                  <Route path="services" element={<ServicesPage />} />
                  <Route path="barbers" element={<BarbersPage />} />
                  <Route path="book" element={<Book />} />
                  <Route path="account" element={<Account />} />
                  <Route path="manage/:ref" element={<Manage />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
                <Route path="login" element={<Login />} />
                <Route path="register" element={<Register />} />
                <Route path="forgot" element={<Forgot />} />
                <Route path="reset/:token" element={<SetPassword mode="reset" />} />
                <Route path="invite/:token" element={<SetPassword mode="invite" />} />
                <Route path="app" element={<AppLayout />}>
                  <Route index element={<AppIndex />} />
                  <Route path="today" element={<Today />} />
                  <Route path="schedule" element={<MySchedule />} />
                  <Route path="earnings" element={<MyEarnings />} />
                  <Route path="overview" element={owner(<Overview />)} />
                  <Route path="calendar" element={owner(<ShopCalendar />)} />
                  <Route path="appointments" element={owner(<Appointments />)} />
                  <Route path="customers" element={owner(<Customers />)} />
                  <Route path="customers/:id" element={owner(<CustomerDetail />)} />
                  <Route path="payments" element={owner(<Payments />)} />
                  <Route path="payroll" element={owner(<Payroll />)} />
                  <Route path="expenses" element={owner(<Expenses />)} />
                  <Route path="reports" element={owner(<Reports />)} />
                  <Route path="team" element={owner(<Team />)} />
                  <Route path="team/:id" element={owner(<TeamDetail />)} />
                  <Route path="services" element={owner(<ServicesAdmin />)} />
                  <Route path="reviews" element={owner(<Reviews />)} />
                  <Route path="outbox" element={owner(<Outbox />)} />
                  <Route path="activity" element={owner(<Activity />)} />
                  <Route path="settings" element={owner(<Settings />)} />
                  <Route path="*" element={<AppIndex />} />
                </Route>
              </Routes>
            </AuthProvider>
          </ShopProvider>
        </ToastProvider>
        </I18nProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
