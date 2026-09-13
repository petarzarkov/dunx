import {
  Body,
  Button,
  Container,
  Heading,
  Html,
  Preview,
  Text,
} from '@react-email/components';
import { body, button, container, muted } from '../styles.js';

export interface WelcomeProps {
  readonly name: string;
  readonly appUrl: string;
}

/**
 * An ordinary React Email component. Nothing here imports dunx: the renderer is
 * what knows about both, which is what keeps a template portable.
 */
const Welcome = ({ name, appUrl }: WelcomeProps) => (
  <Html lang="en">
    <Preview>Your dunx-full account is ready</Preview>
    <Body style={body}>
      <Container style={container}>
        <Heading>Welcome, {name}</Heading>
        <Text>
          Your account on the dunx example app is ready. Everything in it runs
          on Bun.
        </Text>
        <Button href={appUrl} style={button}>
          Open the app
        </Button>
        <Text style={muted}>Sent by dunx-full.</Text>
      </Container>
    </Body>
  </Html>
);

/** What `dunx-email preview` renders it with. React Email's own convention. */
Welcome.PreviewProps = { name: 'Ada', appUrl: 'https://demo.dunx.win' };

export default Welcome;
