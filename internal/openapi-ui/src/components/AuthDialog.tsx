import {
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import type { JSX } from 'react';
import { EMPTY_CREDENTIAL, type AuthState, type Credential } from '../auth';
import type { SecuritySchemeObject } from '../model';

const describe = (scheme: SecuritySchemeObject): string => {
  if (scheme.type === 'apiKey') {
    return `apiKey · ${scheme.in ?? 'header'} · ${scheme.name ?? '?'}`;
  }
  if (scheme.type === 'http') return `http · ${scheme.scheme ?? 'bearer'}`;
  return scheme.type;
};

interface FieldProps {
  readonly name: string;
  readonly scheme: SecuritySchemeObject;
  readonly held: Credential;
  readonly onChange: (next: Credential) => void;
}

const SchemeField = ({
  name,
  scheme,
  held,
  onChange,
}: FieldProps): JSX.Element => {
  const basic = scheme.type === 'http' && scheme.scheme === 'basic';

  return (
    <Stack gap={6}>
      <Group gap="xs">
        <Text fw={600} size="sm" ff="monospace">
          {name}
        </Text>
        <Badge size="xs" variant="light" color="gray">
          {describe(scheme)}
        </Badge>
      </Group>
      {scheme.description !== undefined && (
        <Text size="xs" c="dimmed">
          {scheme.description}
        </Text>
      )}

      {basic ? (
        <Group grow align="flex-start">
          <TextInput
            label="Username"
            size="sm"
            value={held.user}
            onChange={(event) =>
              onChange({ ...held, user: event.currentTarget.value })
            }
          />
          <PasswordInput
            label="Password"
            size="sm"
            value={held.pass}
            onChange={(event) =>
              onChange({ ...held, pass: event.currentTarget.value })
            }
          />
        </Group>
      ) : (
        <PasswordInput
          size="sm"
          className="dunx-monospace"
          label={scheme.type === 'apiKey' ? 'Key' : 'Token'}
          placeholder={
            scheme.type === 'apiKey' ? 'the key value' : 'the bearer token'
          }
          value={held.value}
          onChange={(event) =>
            onChange({ ...held, value: event.currentTarget.value })
          }
          data-scheme={name}
        />
      )}
    </Stack>
  );
};

export interface AuthDialogProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly schemes: Readonly<Record<string, SecuritySchemeObject>>;
  readonly state: AuthState;
  readonly onChange: (next: AuthState) => void;
}

/**
 * Credentials for every scheme the document declares, entered once. The old page
 * had no notion of them: an `Authorization` header was retyped into each
 * operation's header box.
 */
export const AuthDialog = ({
  opened,
  onClose,
  schemes,
  state,
  onChange,
}: AuthDialogProps): JSX.Element => {
  const names = Object.keys(schemes);

  return (
    <Modal opened={opened} onClose={onClose} title="Authorize" size="lg">
      <Stack gap="lg">
        {names.length === 0 && (
          <Text size="sm" c="dimmed">
            This document declares no security schemes.
          </Text>
        )}
        {names.map((name) => (
          <SchemeField
            key={name}
            name={name}
            scheme={schemes[name] as SecuritySchemeObject}
            held={state[name] ?? EMPTY_CREDENTIAL}
            onChange={(next) => onChange({ ...state, [name]: next })}
          />
        ))}
        <Text size="xs" c="dimmed">
          Kept in this tab&rsquo;s <code>sessionStorage</code> and sent only to
          this origin, on operations that declare the scheme.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" size="sm" onClick={() => onChange({})}>
            Clear all
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
