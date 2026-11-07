---
title: Mobile apps with React Native (Expo) and Flutter
summary: Project setup, navigation, data fetching, secure token storage, lists, forms, accessibility, local API URLs, testing and builds.
agents: frontend, ui-ux-design, testing, integration, coder
triggers: mobile, react native, react-native, expo, flutter, dart, ios, android, app store, play store
---
# Mobile apps with React Native (Expo) and Flutter

## React Native with Expo
Start: `npx create-expo-app@latest app` (TypeScript template with Expo Router). Run with `npx expo start`, then press a for Android or scan the QR code with Expo Go.

Navigation (Expo Router, file based):
```
app/
  _layout.tsx           # <Stack /> or <Tabs />, providers (QueryClientProvider, SafeAreaProvider)
  (auth)/login.tsx
  (app)/_layout.tsx     # redirect to /login when there is no session
  (app)/index.tsx
  (app)/bookings/[id].tsx
```
```tsx
// app/(app)/_layout.tsx
export default function AppLayout() {
  const { session, loading } = useSession();
  if (loading) return <Splash />;
  if (!session) return <Redirect href="/login" />;
  return <Stack />;
}
```

Data: TanStack Query works the same as on the web. Configuration through `EXPO_PUBLIC_API_URL` (public: no secrets). Local development: the Android emulator reaches the host machine at `10.0.2.2`, the iOS simulator at `localhost`, a real phone needs the PC's LAN IP and the API bound to `0.0.0.0` (allow it through Windows Firewall).

Tokens: store refresh tokens in `expo-secure-store` (Keychain / Keystore), never in AsyncStorage:
```ts
import * as SecureStore from "expo-secure-store";
await SecureStore.setItemAsync("refreshToken", token);
const t = await SecureStore.getItemAsync("refreshToken");
```

Lists: `FlatList` (or FlashList) with `keyExtractor`, `onEndReached` for pagination, `ListEmptyComponent`, `refreshing`/`onRefresh` for pull to refresh. Never map a long array inside a ScrollView.

Forms: React Hook Form + Zod with `Controller` around `TextInput`; set `keyboardType`, `autoComplete`, `textContentType`, `secureTextEntry`, `returnKeyType`; wrap screens in `KeyboardAvoidingView` and `SafeAreaView` (react-native-safe-area-context).

Accessibility: `accessibilityRole="button"`, `accessibilityLabel` on icon buttons, `accessibilityState={{ disabled }}`, touch targets at least 44 by 44 points (use `hitSlop`), support dynamic font sizes (avoid fixed heights on text containers), test with TalkBack and VoiceOver.

Styling: a theme object from design-system.json (colors for light and dark with `useColorScheme()`), or NativeWind for Tailwind-style classes.

Testing: jest-expo with React Native Testing Library (`render`, `screen.getByRole`, `fireEvent.press`, `await screen.findByText`); Maestro for end-to-end flows. Builds: EAS (`eas build -p android --profile preview`) or `npx expo run:android` for a local build.

## Flutter
Start: `flutter create app`, check the setup with `flutter doctor`. Structure by feature:
```
lib/
  main.dart                 # ProviderScope, MaterialApp.router, theme
  core/ (api client, router, theme)
  features/bookings/ (data/, domain/, presentation/)
```
- State: Riverpod (`flutter_riverpod`) or Bloc; keep widgets free of business logic.
- Navigation: `go_router` with a `redirect` that sends signed-out users to /login.
- HTTP: `dio` or `http` with a base URL from `--dart-define=API_URL=...` (`const String.fromEnvironment("API_URL")`); JSON models with `freezed` and `json_serializable`, or hand-written `fromJson`.
- Tokens: `flutter_secure_storage`.
- Theme: `ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: ...))` plus a dark theme; text styles from the theme, not literal sizes.
- Lists: `ListView.builder` with pagination when scrolled near the end; `RefreshIndicator` for pull to refresh.
- Screen states: model them explicitly (`AsyncValue` in Riverpod gives `loading`, `error`, `data`), and show an empty state for empty data.
- Accessibility: `Semantics(label: ...)` for custom widgets, `tooltip` on IconButton (it doubles as the label), minimum 48 by 48 tap targets (Material default), respect text scaling.
- Quality: `flutter analyze` (with flutter_lints), `flutter test` for unit and widget tests (`testWidgets`, `pumpWidget`, `find.text`, `tester.tap`), `integration_test` for flows.

## Both
Handle offline and slow networks: timeouts, a retry button, cached data shown with a "last updated" note. Ask for permissions (camera, location, notifications) only when the feature needs them, with an explanation first. Keep secrets on the server: anything in the app bundle can be extracted.
