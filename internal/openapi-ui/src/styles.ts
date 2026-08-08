/**
 * Mantine ships one stylesheet per component as well as the `styles.css` barrel.
 * Importing the barrel costs 234 KiB of CSS for a dozen components; importing
 * only what is rendered costs a third of that, and every byte here is inlined
 * into the page `@dunx/openapi` serves. Adding a component means adding its file.
 */
import '@mantine/core/styles/baseline.css';
import '@mantine/core/styles/default-css-variables.css';
import '@mantine/core/styles/global.css';
import '@mantine/core/styles/Accordion.css';
import '@mantine/core/styles/ActionIcon.css';
import '@mantine/core/styles/Alert.css';
import '@mantine/core/styles/Anchor.css';
import '@mantine/core/styles/Badge.css';
import '@mantine/core/styles/Button.css';
import '@mantine/core/styles/Card.css';
import '@mantine/core/styles/CloseButton.css';
import '@mantine/core/styles/Code.css';
import '@mantine/core/styles/Container.css';
import '@mantine/core/styles/Divider.css';
import '@mantine/core/styles/Flex.css';
import '@mantine/core/styles/Group.css';
import '@mantine/core/styles/Input.css';
import '@mantine/core/styles/List.css';
import '@mantine/core/styles/Loader.css';
import '@mantine/core/styles/Modal.css';
import '@mantine/core/styles/ModalBase.css';
import '@mantine/core/styles/Overlay.css';
import '@mantine/core/styles/Paper.css';
import '@mantine/core/styles/PasswordInput.css';
import '@mantine/core/styles/Pill.css';
import '@mantine/core/styles/SimpleGrid.css';
import '@mantine/core/styles/Stack.css';
import '@mantine/core/styles/Table.css';
import '@mantine/core/styles/Tabs.css';
import '@mantine/core/styles/Text.css';
import '@mantine/core/styles/Title.css';
import '@mantine/core/styles/UnstyledButton.css';
import '@mantine/core/styles/VisuallyHidden.css';
import '@dunx/ui/styles.css';
import './app.css';
