import {
  Body,
  Container,
  Heading,
  Hr,
  Html,
  Preview,
  Text,
} from '@react-email/components';
import { body, container, muted, row, total } from '../styles.js';

export interface ReceiptLine {
  readonly description: string;
  readonly amount: number;
}

export interface ReceiptProps {
  readonly reference: string;
  readonly lines: readonly ReceiptLine[];
}

const money = (amount: number): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(amount);

const Receipt = ({ reference, lines }: ReceiptProps) => (
  <Html lang="en">
    <Preview>Receipt {reference}</Preview>
    <Body style={body}>
      <Container style={container}>
        <Heading>Receipt {reference}</Heading>
        {lines.map((line) => (
          <Text key={line.description} style={row}>
            {line.description} {money(line.amount)}
          </Text>
        ))}
        <Hr />
        <Text style={total}>
          Total {money(lines.reduce((sum, line) => sum + line.amount, 0))}
        </Text>
        <Text style={muted}>Sent by dunx-full.</Text>
      </Container>
    </Body>
  </Html>
);

Receipt.PreviewProps = {
  reference: 'INV-2041',
  lines: [
    { description: 'Ledger entries', amount: 42 },
    { description: 'Thumbnail renders', amount: 8.5 },
  ],
};

export default Receipt;
