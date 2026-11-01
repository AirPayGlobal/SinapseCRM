import { Navigate, Route, Routes } from 'react-router-dom';
import { auth } from './api';
import { Account, MyCompany, MyQueries, NewQuery, Notices, PortalLayout, PortalLogin, PortalQuery, PortalRegister, PortalVerify, Survey, Widget } from './portal/Portal';
import Admin from './staff/admin/Admin';
import Capture from './staff/Capture';
import CaseView from './staff/CaseView';
import { useStaff } from './staff/context';
import { Company, Contact, Customers, Registrations } from './staff/Customers';
import { Finding, Findings } from './staff/Findings';
import Knowledge from './staff/Knowledge';
import StaffLayout from './staff/Layout';
import Login from './staff/Login';
import Port from './staff/Port';
import Queue from './staff/Queue';
import Reports from './staff/Reports';
import Review from './staff/Review';

/** Role-based landing view (UE-01.2): agent, supervisor, department head, executive, ICT. */
function Home() {
  const { me } = useStaff();
  const to = ({ queue: '/queue', team: '/team', dashboard: '/dashboard', executive: '/dashboard', integrations: '/admin', findings: '/findings' } as Record<string, string>)[me.landing_view] ?? '/queue';
  return <Navigate to={to} replace />;
}

function RequireStaff({ children }: { children: JSX.Element }) {
  return auth.token('staff') ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/widget" element={<Widget />} />
      <Route path="/survey/:token" element={<Survey />} />
      <Route path="/portal/login" element={<PortalLogin />} />
      <Route path="/portal/register" element={<PortalRegister />} />
      <Route path="/portal/verify" element={<PortalVerify />} />
      <Route path="/portal/activate" element={<PortalVerify activate />} />
      <Route path="/portal" element={<PortalLayout />}>
        <Route index element={<MyQueries />} />
        <Route path="new" element={<NewQuery />} />
        <Route path="queries/:id" element={<PortalQuery />} />
        <Route path="company/:id" element={<MyCompany />} />
        <Route path="notices" element={<Notices />} />
        <Route path="account" element={<Account />} />
      </Route>
      <Route element={<RequireStaff><StaffLayout /></RequireStaff>}>
        <Route path="/" element={<Home />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/team" element={<Queue team />} />
        <Route path="/capture" element={<Capture />} />
        <Route path="/cases/:id" element={<CaseView />} />
        <Route path="/review" element={<Review />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/registrations" element={<Registrations />} />
        <Route path="/customers/companies/:id" element={<Company />} />
        <Route path="/customers/contacts/:id" element={<Contact />} />
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="/dashboard" element={<Reports />} />
        <Route path="/port" element={<Port />} />
        <Route path="/findings" element={<Findings />} />
        <Route path="/findings/:id" element={<Finding />} />
        <Route path="/admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
