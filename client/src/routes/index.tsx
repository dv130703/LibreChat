import { createBrowserRouter, Navigate, Outlet, useParams } from 'react-router-dom';
import {
  Login,
  VerifyEmail,
  Registration,
  ResetPassword,
  ApiErrorWatcher,
  TwoFactorScreen,
  RequestPasswordReset,
} from '~/components/Auth';
import { MarketplaceProvider } from '~/components/Agents/MarketplaceContext';
import AgentMarketplace from '~/components/Agents/Marketplace';
import { OAuthSuccess, OAuthError } from '~/components/OAuth';
import { AuthContextProvider } from '~/hooks/AuthContext';
import WithRum from '~/lib/rum/WithRum';
import RouteErrorBoundary from './RouteErrorBoundary';
import StartupLayout from './Layouts/Startup';
import LoginLayout from './Layouts/Login';
import dashboardRoutes from './Dashboard';
import ShareRoute from './ShareRoute';
import ChatRoute from './ChatRoute';
import Search from './Search';
import Root from './Root';

const AuthLayout = () => (
  <AuthContextProvider>
    <WithRum>
      <Outlet />
    </WithRum>
    <ApiErrorWatcher />
  </AuthContextProvider>
);

/** Phase 5 cutover (transcription/ARCHITECTURE.md §9) - the standalone
 *  `/audio-transcriber/:id` page is retired; bookmarked/shared links to it
 *  keep working by landing on the same conversation with the transcript
 *  panel open, which is now the canonical place to view one. No `?file=`
 *  param: `TranscriptPanel` resolves it itself from the conversation's file
 *  list (`resolveFileTrio`'s no-requested-id fallback, correct here since
 *  every conversation from that standalone-page era carries exactly one
 *  recording), same as it already does for any bare `?panel=transcript`
 *  link. */
const AudioTranscriberRedirect = () => {
  const { conversationId } = useParams();
  return <Navigate to={`/c/${conversationId}?panel=transcript`} replace={true} />;
};

const loadInlinePromptsView = () =>
  import('~/components/Prompts/layouts/InlinePromptsView').then((m) => ({
    Component: m.default,
  }));

const loadSkillsView = () =>
  import('~/components/Skills/layouts/SkillsView').then((m) => ({
    Component: m.default,
  }));

const loadProjectsView = () =>
  import('~/components/Projects').then((m) => ({
    Component: m.ProjectsView,
  }));

const loadProjectWorkspace = () =>
  import('~/components/Projects').then((m) => ({
    Component: m.ProjectWorkspace,
  }));

const loadAgentBuilderView = () =>
  import('~/components/Agents/layouts/AgentBuilderView').then((m) => ({
    Component: m.default,
  }));

const loadTransparencyView = () =>
  import('~/components/Transparency/TransparencyView').then((m) => ({
    Component: m.default,
  }));

const loadVoiceProfilesView = () =>
  import('~/components/VoiceProfiles/VoiceProfilesView').then((m) => ({
    Component: m.default,
  }));

const baseEl = document.querySelector('base');
const baseHref = baseEl?.getAttribute('href') || '/';

export const router = createBrowserRouter(
  [
    {
      path: 'share/:shareId',
      element: <ShareRoute />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      path: 'oauth',
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: 'success',
          element: <OAuthSuccess />,
        },
        {
          path: 'error',
          element: <OAuthError />,
        },
      ],
    },
    {
      path: '/',
      element: <StartupLayout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: 'register',
          element: <Registration />,
        },
        {
          path: 'forgot-password',
          element: <RequestPasswordReset />,
        },
        {
          path: 'reset-password',
          element: <ResetPassword />,
        },
      ],
    },
    {
      path: 'verify',
      element: <VerifyEmail />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      element: <AuthLayout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: '/',
          element: <LoginLayout />,
          children: [
            {
              path: 'login',
              element: <Login />,
            },
            {
              path: 'login/2fa',
              element: <TwoFactorScreen />,
            },
          ],
        },
        dashboardRoutes,
        {
          path: '/',
          element: <Root />,
          children: [
            {
              index: true,
              element: <Navigate to="/c/new" replace={true} />,
            },
            {
              path: 'c/:conversationId?',
              element: <ChatRoute />,
            },
            {
              path: 'search',
              element: <Search />,
            },
            {
              path: 'prompts',
              element: <Navigate to="/prompts/new" replace={true} />,
            },
            {
              path: 'prompts/new',
              lazy: loadInlinePromptsView,
            },
            {
              path: 'prompts/:promptId',
              lazy: loadInlinePromptsView,
            },
            {
              path: 'skills',
              lazy: loadSkillsView,
            },
            {
              path: 'skills/new',
              lazy: loadSkillsView,
            },
            {
              path: 'skills/:skillId',
              lazy: loadSkillsView,
            },
            {
              path: 'skills/:skillId/edit',
              lazy: loadSkillsView,
            },
            {
              path: 'projects',
              lazy: loadProjectsView,
            },
            {
              path: 'projects/:projectId',
              lazy: loadProjectWorkspace,
            },
            {
              path: 'audio-transcriber/:conversationId',
              element: <AudioTranscriberRedirect />,
            },
            {
              path: 'agents',
              element: (
                <MarketplaceProvider>
                  <AgentMarketplace />
                </MarketplaceProvider>
              ),
            },
            {
              path: 'agents/:category',
              element: (
                <MarketplaceProvider>
                  <AgentMarketplace />
                </MarketplaceProvider>
              ),
            },
            {
              path: 'agents/builder',
              element: <Navigate to="/agents/builder/new" replace={true} />,
            },
            {
              path: 'agents/builder/new',
              lazy: loadAgentBuilderView,
            },
            {
              path: 'agents/builder/:agentId',
              lazy: loadAgentBuilderView,
            },
            {
              path: 'transparency/:conversationId/:messageId',
              lazy: loadTransparencyView,
            },
            {
              path: 'information-management',
              lazy: loadVoiceProfilesView,
            },
            /* Renamed from `voice-profiles`; kept so existing bookmarks and
             * any link already shared internally still land, same as
             * `audio-transcriber/:conversationId` above. */
            {
              path: 'voice-profiles',
              element: <Navigate to="/information-management" replace={true} />,
            },
          ],
        },
      ],
    },
  ],
  { basename: baseHref },
);
