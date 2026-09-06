import React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { tokenizeCode } from './simpleSyntaxTokenizer';

interface SimpleSyntaxHighlighterProps {
  code: string;
  language: string | null;
  selectable: boolean;
  fontSize?: number;
  wrap?: boolean;
}

// Get theme-aware colors
const getColors = (theme: any) => ({
  // Use theme colors directly for syntax highlighting
  keyword: theme.colors.syntaxKeyword,
  controlFlow: theme.colors.syntaxKeyword,
  type: theme.colors.syntaxKeyword,
  modifier: theme.colors.syntaxKeyword,
  
  string: theme.colors.syntaxString,
  number: theme.colors.syntaxNumber,
  boolean: theme.colors.syntaxNumber,
  regex: theme.colors.syntaxString,
  
  function: theme.colors.syntaxFunction,
  method: theme.colors.syntaxFunction,
  property: theme.colors.syntaxDefault,
  
  comment: theme.colors.syntaxComment,
  docstring: theme.colors.syntaxComment,
  
  operator: theme.colors.syntaxDefault,
  assignment: theme.colors.syntaxKeyword,
  comparison: theme.colors.syntaxKeyword,
  logical: theme.colors.syntaxKeyword,
  
  bracket1: theme.colors.syntaxBracket1,
  bracket2: theme.colors.syntaxBracket2,
  bracket3: theme.colors.syntaxBracket3,
  bracket4: theme.colors.syntaxBracket4,
  bracket5: theme.colors.syntaxBracket5,
  
  decorator: theme.colors.syntaxKeyword,
  import: theme.colors.syntaxKeyword,
  variable: theme.colors.syntaxDefault,
  parameter: theme.colors.syntaxDefault,
  
  default: theme.colors.syntaxDefault,
  punctuation: theme.colors.syntaxDefault,
});

// Tokenization lives in simpleSyntaxTokenizer.ts (pure, unit-tested): it
// runs synchronously during render, so its regexes are linear and its work is
// budgeted — a 64k-digit literal used to freeze the UI for seconds (#241).

export const SimpleSyntaxHighlighter: React.FC<SimpleSyntaxHighlighterProps> = ({
  code,
  language,
  selectable,
  fontSize = 14,
  wrap = true,
}) => {
  const { theme } = useUnistyles();
  const colors = getColors(theme);
  const tokens = tokenizeCode(code, language);

  const getColorForType = (type: string, nestLevel?: number): string => {
    switch (type) {
      case 'keyword': return colors.keyword;
      case 'controlFlow': return colors.controlFlow;
      case 'type': return colors.type;
      case 'modifier': return colors.modifier;
      case 'string': return colors.string;
      case 'number': return colors.number;
      case 'boolean': return colors.boolean;
      case 'regex': return colors.regex;
      case 'function': return colors.function;
      case 'method': return colors.method;
      case 'property': return colors.property;
      case 'comment': return colors.comment;
      case 'docstring': return colors.docstring;
      case 'operator': return colors.operator;
      case 'assignment': return colors.assignment;
      case 'comparison': return colors.comparison;
      case 'logical': return colors.logical;
      case 'decorator': return colors.decorator;
      case 'import': return colors.import;
      case 'variable': return colors.variable;
      case 'parameter': return colors.parameter;
      case 'punctuation': return colors.punctuation;
      case 'bracket': 
        switch ((nestLevel || 1) % 5) {
          case 1: return colors.bracket1;
          case 2: return colors.bracket2;
          case 3: return colors.bracket3;
          case 4: return colors.bracket4;
          case 0: return colors.bracket5; // Level 5, 10, 15, etc.
          default: return colors.bracket1;
        }
      default: return colors.default;
    }
  };

  const lineHeight = Math.round(fontSize * 1.43);
  return (
    <View>
      <Text 
        selectable={selectable}
        {...(wrap ? {} : { numberOfLines: undefined })}
        style={{ 
          fontFamily: Typography.mono().fontFamily,
          fontSize,
          lineHeight,
        }}
      >
        {tokens.map((token, index) => (
          <Text
            key={index}
            selectable={selectable}
            style={{
              color: getColorForType(token.type, token.nestLevel),
              fontFamily: Typography.mono().fontFamily,
              fontWeight: ['keyword', 'controlFlow', 'type', 'function'].includes(token.type) ? '600' : '400',
            }}
          >
            {token.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}; 