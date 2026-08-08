/**
 * Mantine ships one stylesheet per component as well as the `styles.css` barrel.
 * Importing the barrel costs 234 KiB of CSS for a couple of dozen components;
 * importing only what is rendered costs a fraction of that, and every byte here is
 * inlined into the page `@dunx/dashboard` serves. Adding a component means adding
 * its file - the same discipline `internal/openapi-ui` keeps, and for the same
 * reason.
 */
import '@mantine/core/styles/baseline.css';
import '@mantine/core/styles/default-css-variables.css';
import '@mantine/core/styles/global.css';
import '@mantine/core/styles/ActionIcon.css';
import '@mantine/core/styles/Alert.css';
import '@mantine/core/styles/Anchor.css';
import '@mantine/core/styles/AppShell.css';
import '@mantine/core/styles/Badge.css';
import '@mantine/core/styles/Burger.css';
import '@mantine/core/styles/Button.css';
import '@mantine/core/styles/CloseButton.css';
import '@mantine/core/styles/Code.css';
import '@mantine/core/styles/Container.css';
import '@mantine/core/styles/Drawer.css';
import '@mantine/core/styles/Flex.css';
import '@mantine/core/styles/Group.css';
import '@mantine/core/styles/Input.css';
import '@mantine/core/styles/Loader.css';
import '@mantine/core/styles/ModalBase.css';
import '@mantine/core/styles/NavLink.css';
import '@mantine/core/styles/Overlay.css';
import '@mantine/core/styles/Paper.css';
import '@mantine/core/styles/ScrollArea.css';
import '@mantine/core/styles/SegmentedControl.css';
import '@mantine/core/styles/SimpleGrid.css';
import '@mantine/core/styles/Stack.css';
import '@mantine/core/styles/Switch.css';
import '@mantine/core/styles/Table.css';
import '@mantine/core/styles/Text.css';
import '@mantine/core/styles/Title.css';
import '@mantine/core/styles/UnstyledButton.css';
import '@mantine/core/styles/VisuallyHidden.css';
import '@dunx/ui/styles.css';
