import * as React from 'react';
import { Modal } from '@/modal';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { sessionAllow } from '@/sync/ops';
import { useDoubleTap } from '@/hooks/useDoubleTap';
import { t } from '@/text';
import Ionicons from '@expo/vector-icons/Ionicons';
import { getToolModel, ToolCallModel } from '@/sync/toolModel';

interface QuestionOption {
    label: string;
    description: string;
}

interface Question {
    question: string;
    header: string;
    options: QuestionOption[];
    multiSelect: boolean;
}

// Styles MUST be defined outside the component to prevent infinite re-renders
// with react-native-unistyles. The theme is passed as a function parameter.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    questionSection: {
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginBottom: 4,
    },
    headerText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 8,
    },
    optionsContainer: {
        gap: 4,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
        minHeight: 44, // Minimum touch target for mobile
    },
    optionButtonSelected: {
        backgroundColor: theme.colors.surfaceHigh,
        borderColor: theme.colors.radio.active,
    },
    optionButtonArmed: {
        borderColor: theme.colors.radio.active,
        borderWidth: 2,
    },
    optionButtonDisabled: {
        opacity: 0.6,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    radioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    checkboxOuter: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    checkboxOuterSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
    optionContent: {
        flex: 1,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
        justifyContent: 'flex-end',
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44, // Minimum touch target for mobile
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonArmed: {
        opacity: 0.7,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 14,
        fontWeight: '600',
    },
    submittedContainer: {
        gap: 8,
    },
    submittedItem: {
        flexDirection: 'row',
        gap: 8,
    },
    submittedHeader: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    submittedValue: {
        fontSize: 13,
        color: theme.colors.text,
        flex: 1,
    },
}));

/** The validated question list, or an empty list for any other shape. */
function questionsOf(model: ToolCallModel): Question[] {
    const raw = model.arguments.value.questions;
    if (!Array.isArray(raw)) return [];
    const questions: Question[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const options: QuestionOption[] = [];
        if (Array.isArray(record.options)) {
            for (const option of record.options) {
                if (!option || typeof option !== 'object') continue;
                const optionRecord = option as Record<string, unknown>;
                if (typeof optionRecord.label !== 'string') continue;
                options.push({ label: optionRecord.label, description: typeof optionRecord.description === 'string' ? optionRecord.description : '' });
            }
        }
        questions.push({
            question: typeof record.question === 'string' ? record.question : '',
            header: typeof record.header === 'string' ? record.header : '',
            options,
            multiSelect: record.multiSelect === true,
        });
    }
    return questions;
}

/**
 * Answers persisted with the call — `input.answers` (the approval echoes the
 * answers into the tool input) or a structured `{answers}` result — keyed by
 * question text. Local selections only matter while this card submits.
 */
function persistedAnswers(model: ToolCallModel): Record<string, string> {
    const answers: Record<string, string> = {};
    const collect = (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        for (const [question, answer] of Object.entries(value as Record<string, unknown>)) {
            if (typeof answer === 'string') answers[question] = answer;
            else if (Array.isArray(answer)) answers[question] = answer.filter((a): a is string => typeof a === 'string').join(', ');
        }
    };
    collect(model.arguments.value.answers);
    for (const block of model.blocks) {
        if (block.kind === 'structured' && block.value && typeof block.value === 'object') {
            collect((block.value as Record<string, unknown>).answers);
        }
    }
    return answers;
}

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    // Every hook runs before any input-dependent return: a card that first
    // rendered with `input: {}` and then received its questions used to throw
    // "Rendered more hooks than during the previous render".
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [isSubmitted, setIsSubmitted] = React.useState(false);
    const { armedKey, requireDoubleTap } = useDoubleTap();

    const model = getToolModel(tool);
    const questions = React.useMemo(() => questionsOf(model), [model]);
    const persisted = React.useMemo(() => persistedAnswers(model), [model]);

    const isRunning = model.outcome === 'pending';
    const canInteract = isRunning && !isSubmitted;

    // Check if all questions have at least one selection
    const allQuestionsAnswered = questions.length > 0 && questions.every((_, qIndex) => {
        const selected = selections.get(qIndex);
        return selected && selected.size > 0;
    });

    const handleOptionToggle = React.useCallback((questionIndex: number, optionIndex: number, multiSelect: boolean) => {
        if (!canInteract) return;

        setSelections(prev => {
            const newMap = new Map(prev);
            const currentSet = newMap.get(questionIndex) || new Set();

            if (multiSelect) {
                // Toggle for multi-select
                const newSet = new Set(currentSet);
                if (newSet.has(optionIndex)) {
                    newSet.delete(optionIndex);
                } else {
                    newSet.add(optionIndex);
                }
                newMap.set(questionIndex, newSet);
            } else {
                // Replace for single-select
                newMap.set(questionIndex, new Set([optionIndex]));
            }

            return newMap;
        });
    }, [canInteract]);

    const handleSubmit = React.useCallback(async () => {
        if (!sessionId || !allQuestionsAnswered || isSubmitting) return;

        setIsSubmitting(true);

        // HACK: Disable the form immediately by switching to the submitted view.
        // Without this, users could edit their selections while the network calls
        // are in flight, but those edits would be ignored since we've already
        // captured the values above. TODO: Revisit this logic.
        setIsSubmitted(true);

        const answers: Record<string, string> = {};
        questions.forEach((q, qIndex) => {
            const selected = selections.get(qIndex);
            if (selected && selected.size > 0) {
                const selectedLabels = Array.from(selected)
                    .map(optIndex => q.options[optIndex]?.label)
                    .filter(Boolean)
                    .join(', ');
                answers[q.question] = selectedLabels;
            }
        });

        try {
            // AskUserQuestion expects answers to be returned as part of the tool input,
            // not as a follow-up plain text message.
            if (tool.permission?.id) {
                await sessionAllow(sessionId, tool.permission.id, undefined, undefined, 'approved', { answers });
            } else {
                // No permission id (v2): there is no channel from this card to the
                // question picker Claude is showing in its TUI — a plain message
                // would only queue a new turn the relay cannot start while the
                // question's turn runs (#15). The answer belongs in the dialog bar.
                throw new Error('no answer channel');
            }
        } catch (error) {
            console.error('Failed to submit answer:', error);
            setIsSubmitted(false); // the form comes back: nothing reached the agent
            Modal.alert(t('common.error'), t('errors.sendFailedMessage'), [{ text: t('common.ok'), style: 'cancel' }]);
        } finally {
            setIsSubmitting(false);
        }
    }, [sessionId, questions, selections, allQuestionsAnswered, isSubmitting, tool.permission?.id]);

    if (questions.length === 0) {
        return null;
    }

    // Show submitted state — from the persisted answers first, so a completed
    // question reopened later still shows what was chosen.
    if (isSubmitted || model.outcome !== 'pending') {
        return (
            <ToolSectionView>
                <View style={styles.submittedContainer}>
                    {questions.map((q, qIndex) => {
                        const selected = selections.get(qIndex);
                        const localLabels = selected && selected.size > 0
                            ? Array.from(selected)
                                .map(optIndex => q.options[optIndex]?.label)
                                .filter(Boolean)
                                .join(', ')
                            : null;
                        const persistedLabel = persisted[q.question] ?? persisted[q.header] ?? null;
                        const answer = persistedLabel ?? localLabels
                            ?? (questions.length === 1 && model.outcome === 'succeeded' && model.outputText ? model.outputText : '-');
                        return (
                            <View key={qIndex} style={styles.submittedItem}>
                                <Text style={styles.submittedHeader}>{q.header}:</Text>
                                <Text style={styles.submittedValue}>{answer}</Text>
                            </View>
                        );
                    })}
                </View>
            </ToolSectionView>
        );
    }

    // v2 sessions have no permission id: render read-only and say where to answer.
    const readOnly = !tool.permission?.id;
    return (
        <ToolSectionView>
            <View style={styles.container}>
                {readOnly ? <Text style={styles.questionText}>{t('tools.askUserQuestion.answerInDialog')}</Text> : null}
                {questions.map((question, qIndex) => {
                    const selectedOptions = selections.get(qIndex) || new Set();

                    return (
                        <View key={qIndex} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{question.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{question.question}</Text>
                            <View style={styles.optionsContainer}>
                                {question.options.map((option, oIndex) => {
                                    const isSelected = selectedOptions.has(oIndex);
                                    const optionKey = `q${qIndex}:o${oIndex}`;
                                    const isArmed = armedKey === optionKey;

                                    return (
                                        <TouchableOpacity
                                            key={oIndex}
                                            style={[
                                                styles.optionButton,
                                                isSelected && styles.optionButtonSelected,
                                                isArmed && styles.optionButtonArmed,
                                                !canInteract && styles.optionButtonDisabled,
                                            ]}
                                            onPress={() => requireDoubleTap(optionKey, () => handleOptionToggle(qIndex, oIndex, question.multiSelect))}
                                            disabled={!canInteract || readOnly}
                                            activeOpacity={0.7}
                                        >
                                            {question.multiSelect ? (
                                                <View style={[
                                                    styles.checkboxOuter,
                                                    isSelected && styles.checkboxOuterSelected,
                                                ]}>
                                                    {isSelected ? (
                                                        <Ionicons name="checkmark" size={14} color="#fff" />
                                                    ) : null}
                                                </View>
                                            ) : (
                                                <View style={[
                                                    styles.radioOuter,
                                                    isSelected && styles.radioOuterSelected,
                                                ]}>
                                                    {isSelected ? <View style={styles.radioInner} /> : null}
                                                </View>
                                            )}
                                            <View style={styles.optionContent}>
                                                <Text style={styles.optionLabel}>{option.label}</Text>
                                                {option.description ? (
                                                    <Text style={styles.optionDescription}>{option.description}</Text>
                                                ) : null}
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                    );
                })}

                {canInteract ? (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            style={[
                                styles.submitButton,
                                armedKey === 'submit' && styles.submitButtonArmed,
                                (!allQuestionsAnswered || isSubmitting) && styles.submitButtonDisabled,
                            ]}
                            onPress={() => requireDoubleTap('submit', handleSubmit)}
                            disabled={!allQuestionsAnswered || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                            ) : (
                                <Text style={styles.submitButtonText}>
                                    {armedKey === 'submit' ? t('tools.askUserQuestion.tapAgain') : t('tools.askUserQuestion.submit')}
                                </Text>
                            )}
                        </TouchableOpacity>
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});
