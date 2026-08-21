import { platformLabel } from '@clinmesh/core/platform'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaView, StyleSheet, Text, View } from 'react-native'

const items = [
  ['FHIR R5', '与 Web/Desktop 使用同一协议和领域语义。'],
  ['Mobile UI', '导航、控件、存储和网络生命周期由移动端独立实现。'],
  ['Agent context', '高风险操作仍受服务端 context binding 和审批约束。'],
] as const

export default function HomeScreen(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.brand}>ClinMesh</Text>
        <Text style={styles.platform}>{platformLabel('mobile')}</Text>
      </View>
      <View style={styles.content}>
        <Text style={styles.heading}>移动诊疗工作台</Text>
        <Text style={styles.lead}>移动端保持产品语义一致，同时使用适合查房和随访的原生交互。</Text>
        <View style={styles.list}>
          {items.map(([title, copy]) => (
            <View key={title} style={styles.item}>
              <Text style={styles.itemTitle}>{title}</Text>
              <Text style={styles.itemCopy}>{copy}</Text>
            </View>
          ))}
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f7f8fa' },
  header: {
    minHeight: 52,
    paddingHorizontal: 20,
    borderBottomColor: '#dfe3e8',
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { color: '#1d2433', fontSize: 18, fontWeight: '700' },
  platform: { color: '#5e6878', fontSize: 13 },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: 28 },
  heading: { color: '#1d2433', fontSize: 24, fontWeight: '700' },
  lead: { color: '#5e6878', fontSize: 15, lineHeight: 23, marginTop: 8 },
  list: { gap: 12, marginTop: 24 },
  item: { minHeight: 104, padding: 16, borderRadius: 6, borderColor: '#dfe3e8', borderWidth: 1, backgroundColor: '#ffffff' },
  itemTitle: { color: '#1d2433', fontSize: 15, fontWeight: '700' },
  itemCopy: { color: '#5e6878', fontSize: 13, lineHeight: 20, marginTop: 8 },
})
